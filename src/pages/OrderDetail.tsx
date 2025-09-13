// ===========================================================
// OrderDetail.tsx
// - Page view for a single order
// - Reads order + related entities
// - Tabs: Details / Result Intake / Audit Trail
// - After result processed: reload data + switch to Audit tab
// - Mobile friendly + block-organized for easy editing
// ===========================================================

import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "../utils/supabase";
import { ResultIntake } from "../components/Orders/ResultIntake";
import { ResultAudit } from "../components/Orders/ResultAudit";
import { useOrderStatusSync } from "../hooks/useOrderStatusSync";

// ===========================================================
// #region Types
// ===========================================================

type AnalyteLite = {
  id: string;
  name: string;
  unit?: string;
  reference_range?: string;
  ai_processing_type?: string | null;
  ai_prompt_override?: string | null;
  code?: string;
  units?: string;
  existing_result?: {
    id: string;
    value: string;
    status: string;
    verified_at?: string;
  } | null;
};

type TestGroupForOrder = {
  test_group_id: string;
  test_group_name: string;
  order_test_group_id?: string | null;
  order_test_id?: string | null;
  analytes: AnalyteLite[];
};

interface Order {
  id: string;
  order_number: string;
  lab_id: string;
  test_group_id?: string;
  test_code?: string;
  patient_id: string;
  status: string;
  priority?: string;
  created_at: string;
  // Related / denormalized fields we populate below
  patient_name?: string;
  patient_dob?: string;
  patient_gender?: string;
  test_group_name?: string;
  sample_id?: string;
  test_groups?: TestGroupForOrder[];
}

// ===========================================================
// #endregion Types
// ===========================================================

export default function OrderDetail() {
  // =========================================================
  // #region State & wiring
  // =========================================================
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"details" | "results" | "audit">(
    "details"
  );
  const [workflowResultId, setWorkflowResultId] = useState<string>();

  // keep order.status live
  useOrderStatusSync(id || "", (newStatus) => {
    setOrder((prev) => (prev ? { ...prev, status: newStatus } : prev));
  });

  // =========================================================
  // #endregion State & wiring
  // =========================================================

  // =========================================================
  // #region Data Loading
  // =========================================================

  const loadOrder = useCallback(async () => {
    if (!id) return;

    try {
      setLoading(true);
      setError(null);

      // Pull order + patient + tests from both sources + samples + results
      const { data, error } = await supabase
        .from("orders")
        .select(
          `
          *,
          patients!inner(
            id,
            name,
            dob,
            gender,
            phone
          ),
          order_test_groups(
            id,
            test_group_id,
            test_name,
            price,
            test_groups(
              id,
              name,
              code,
              category,
              lab_id,
              test_group_analytes(
                analyte_id,
                analytes(
                  id,
                  name,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override
                )
              )
            )
          ),
          order_tests(
            id,
            test_name,
            test_group_id,
            sample_id,
            test_groups(
              id,
              name,
              code,
              category,
              lab_id,
              test_group_analytes(
                analyte_id,
                analytes(
                  id,
                  name,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override
                )
              )
            )
          ),
          samples(
            id,
            sample_type,
            barcode,
            status,
            collected_at,
            collected_by,
            container_type
          ),
          results(
            id,
            order_id,
            test_name,
            status,
            verified_at,
            verified_by,
            created_at,
            order_test_group_id,
            order_test_id,
            test_group_id,
            lab_id,
            result_values(
              id,
              analyte_name,
              value,
              unit,
              reference_range,
              flag,
              analyte_id,
              order_test_group_id,
              order_test_id
            )
          )
        `
        )
        .eq("id", id)
        .single();

      if (error) throw error;

      // Build test groups from both order_test_groups and order_tests
      const testGroupsFromOTG =
        data.order_test_groups
          ?.filter((otg: any) => otg.test_groups)
          .map((otg: any) => ({
            test_group_id: otg.test_groups.id,
            test_group_name: otg.test_groups.name,
            order_test_group_id: otg.id,
            order_test_id: null,
            analytes:
              otg.test_groups.test_group_analytes?.map((tga: any) => ({
                ...tga.analytes,
                code: otg.test_groups.code,
                units: tga.analytes.unit,
                existing_result:
                  data.results
                    ?.find((r: any) => r.order_test_group_id === otg.id)
                    ?.result_values?.find(
                      (rv: any) => rv.analyte_id === tga.analytes.id
                    ) || null,
              })) || [],
          })) || [];

      const testGroupsFromOT =
        data.order_tests
          ?.filter((ot: any) => ot.test_groups && ot.test_group_id)
          .map((ot: any) => ({
            test_group_id: ot.test_groups.id,
            test_group_name: ot.test_groups.name,
            order_test_group_id: null,
            order_test_id: ot.id,
            analytes:
              ot.test_groups.test_group_analytes?.map((tga: any) => ({
                ...tga.analytes,
                code: ot.test_groups.code,
                units: tga.analytes.unit,
                existing_result:
                  data.results
                    ?.find((r: any) => r.order_test_id === ot.id)
                    ?.result_values?.find(
                      (rv: any) => rv.analyte_id === tga.analytes.id
                    ) || null,
              })) || [],
          })) || [];

      // Merge by test_group_id & union analytes
      const merged: TestGroupForOrder[] = [...testGroupsFromOTG, ...testGroupsFromOT].reduce(
        (acc: TestGroupForOrder[], current: TestGroupForOrder) => {
          const idx = acc.findIndex((tg) => tg.test_group_id === current.test_group_id);
          if (idx === -1) {
            acc.push(current);
          } else {
            const existing = acc[idx];
            const mergedAnalytes = [...existing.analytes];
            current.analytes.forEach((a) => {
              if (!mergedAnalytes.find((m) => m.id === a.id)) mergedAnalytes.push(a);
            });
            acc[idx] = {
              ...existing,
              analytes: mergedAnalytes,
              order_test_group_id:
                existing.order_test_group_id || current.order_test_group_id,
              order_test_id: existing.order_test_id || current.order_test_id,
            };
          }
          return acc;
        },
        []
      );

      const formatted: Order = {
        ...data,
        patient_name: data.patients?.name,
        patient_dob: data.patients?.dob,
        patient_gender: data.patients?.gender,
        test_groups: merged,
        sample_id: data.samples?.[0]?.barcode || data.samples?.[0]?.id,
      };

      setOrder(formatted);
    } catch (e) {
      console.error("Error loading order:", e);
      setError("Failed to load order details");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // =========================================================
  // #endregion Data Loading
  // =========================================================

  // =========================================================
  // #region Handlers & UI helpers
  // =========================================================

  const handleResultProcessed = (resultId: string) => {
    setWorkflowResultId(resultId);
    // reload so test_groups reflect freshly created result_values
    loadOrder();
    setActiveTab("audit");
  };

  const getStatusBadge = (status: string) => {
    const base = "px-3 py-1 rounded-full text-sm font-medium";
    switch (status) {
      case "completed":
      case "complete":
        return `${base} bg-green-100 text-green-800`;
      case "in_progress":
      case "in_process":
        return `${base} bg-blue-100 text-blue-800`;
      case "pending_collection":
      case "pending":
        return `${base} bg-yellow-100 text-yellow-800`;
      case "pending_approval":
        return `${base} bg-orange-100 text-orange-800`;
      case "cancelled":
        return `${base} bg-red-100 text-red-800`;
      case "delivered":
        return `${base} bg-gray-100 text-gray-800`;
      default:
        return `${base} bg-gray-100 text-gray-800`;
    }
  };

  const getTabClasses = (tab: string) =>
    activeTab === tab
      ? "pb-2 px-1 border-b-2 border-blue-500 text-blue-600 font-medium text-sm"
      : "pb-2 px-1 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 font-medium text-sm";

  // =========================================================
  // #endregion Handlers & UI helpers
  // =========================================================

  // =========================================================
  // #region Loading / Error states
  // =========================================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        <span className="ml-2">Loading order...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <div className="flex flex-col items-center">
          <svg
            className="h-12 w-12 text-red-400 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-red-500 text-lg">{error}</p>
          <button
            onClick={() => navigate("/orders")}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Back to Orders
          </button>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="text-center py-8">
        <div className="flex flex-col items-center">
          <svg
            className="h-12 w-12 text-gray-400 mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <p className="text-gray-500 text-lg">Order not found</p>
          <button
            onClick={() => navigate("/orders")}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Back to Orders
          </button>
        </div>
      </div>
    );
  }

  // =========================================================
  // #endregion Loading / Error states
  // =========================================================

  // =========================================================
  // #region Render
  // =========================================================

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <button
          onClick={() => navigate("/orders")}
          className="flex items-center text-gray-600 hover:text-gray-900 mb-4 transition-colors"
        >
          <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Orders
        </button>

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Order #{order.order_number}</h1>
          <span className={getStatusBadge(order.status)}>
            {order.status === "pending_collection"
              ? "Pending Collection"
              : order.status === "in_process"
              ? "In Process"
              : order.status === "pending_approval"
              ? "Pending Approval"
              : order.status}
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b mb-6 overflow-x-auto">
        <nav className="flex space-x-8">
          <button onClick={() => setActiveTab("details")} className={getTabClasses("details")}>
            <svg className="h-4 w-4 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Order Details
          </button>
          <button onClick={() => setActiveTab("results")} className={getTabClasses("results")}>
            <svg className="h-4 w-4 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Result Intake
          </button>
          <button onClick={() => setActiveTab("audit")} className={getTabClasses("audit")}>
            <svg className="h-4 w-4 inline mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Audit Trail
          </button>
        </nav>
      </div>

      {/* Content */}
      <div className="bg-white rounded-lg shadow border p-6">
        {activeTab === "details" && (
          <div className="space-y-6">
            {/* Patient Information */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Patient Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Patient Name</h4>
                  <p className="text-lg">{order.patient_name}</p>
                </div>
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Gender & DOB</h4>
                  <p>
                    {order.patient_gender} •{" "}
                    {order.patient_dob ? new Date(order.patient_dob).toLocaleDateString() : "Not provided"}
                  </p>
                </div>
              </div>
            </div>

            {/* Test Information */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Test Information</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Test</h4>
                  <p>{order.test_group_name || order.test_code || "Not specified"}</p>
                </div>
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Priority</h4>
                  <p>{order.priority || "Normal"}</p>
                </div>
              </div>
            </div>

            {/* Sample Information */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Sample Information</h3>
              <div className="bg-gray-50 p-3 rounded">
                <h4 className="text-sm font-medium text-gray-500 mb-1">Sample ID</h4>
                {order.sample_id ? (
                  <p className="font-mono">{order.sample_id}</p>
                ) : (
                  <p className="text-yellow-600 flex items-center">
                    <svg className="h-4 w-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    Sample not collected
                  </p>
                )}
              </div>
            </div>

            {/* Order Metadata */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Order Details</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Order Date</h4>
                  <p>{new Date(order.created_at).toLocaleString()}</p>
                </div>
                <div className="bg-gray-50 p-3 rounded">
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Status</h4>
                  <span className={getStatusBadge(order.status)}>{order.status}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "results" && order.patient_name && (
          <ResultIntake
            order={{
              id: order.id,
              lab_id: order.lab_id,
              patient_id: order.patient_id,
              patient_name: order.patient_name,
              test_groups: order.test_groups || [],
              sample_id: order.sample_id,
              status: order.status,
            }}
            onResultProcessed={handleResultProcessed}
          />
        )}

        {activeTab === "audit" && (
          <ResultAudit orderId={order.id} workflowResultId={workflowResultId} />
        )}
      </div>
    </div>
  );
  // =========================================================
  // #endregion Render
  // =========================================================
}
