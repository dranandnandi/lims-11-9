import { useState, useEffect } from 'react'
import { getWorkflows } from '../utils/workflowAPI'
import SimpleWorkflowRunner from '../components/Workflow/SimpleWorkflowRunner'
import { supabase } from '../utils/supabase'

interface Order {
  id: string
  patient_name: string
  test_group_name?: string
  test_code?: string
}

export default function WorkflowDemo() {
  const [workflows, setWorkflows] = useState<any[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [selectedWorkflow, setSelectedWorkflow] = useState<any>(null)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch workflows and orders
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        
        // Fetch workflows
        const workflowData = await getWorkflows()
        setWorkflows(workflowData)

        // Fetch sample orders for testing
        const { data: orderData, error: orderError } = await supabase
          .from('orders')
          .select(`
            id,
            patient_name,
            patients(name),
            order_tests(
              test_groups(
                id,
                name
              )
            )
          `)
          .limit(10)
          .order('created_at', { ascending: false })

        if (orderError) {
          console.warn('No orders found or error fetching orders:', orderError)
          setOrders([])
        } else {
          const formattedOrders = (orderData || []).map((order: any) => ({
            id: order.id,
            patient_name: order.patient_name || order.patients?.name || 'Unknown Patient',
            test_group_name: order.order_tests?.[0]?.test_groups?.name,
            test_code: order.order_tests?.[0]?.test_groups?.id
          }))
          
          setOrders(formattedOrders)
        }

      } catch (err) {
        console.error('Error fetching data:', err)
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [])

  const handleWorkflowComplete = (results: any) => {
    console.log('Workflow completed with results:', results)
    alert('Workflow completed successfully! Check the console for results.')
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        <span className="ml-2">Loading...</span>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Workflow Demo</h1>
        <p className="text-gray-600">
          Test the AI-powered workflow system with order gating
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-center text-red-800">
            <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span>{error}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Order Selection */}
        <div className="bg-white rounded-lg shadow border p-6">
          <h2 className="text-lg font-semibold mb-4">Select Order</h2>
          {orders.length === 0 ? (
            <div className="text-center py-4">
              <svg className="h-12 w-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2h-2a2 2 0 01-2-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p className="text-gray-500">No orders available</p>
              <p className="text-sm text-gray-400 mt-1">Create an order first to test workflows</p>
            </div>
          ) : (
            <div className="space-y-2">
              {orders.map(order => (
                <button
                  key={order.id}
                  onClick={() => setSelectedOrder(order)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    selectedOrder?.id === order.id
                      ? 'bg-blue-50 border-blue-200'
                      : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  <div className="font-medium">Order #{order.id.slice(0, 8)}</div>
                  <div className="text-sm text-gray-600">{order.patient_name}</div>
                  <div className="text-xs text-gray-500">
                    {order.test_group_name || order.test_code || 'No test specified'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Workflow Selection */}
        <div className="bg-white rounded-lg shadow border p-6">
          <h2 className="text-lg font-semibold mb-4">Select Workflow</h2>
          {workflows.length === 0 ? (
            <div className="text-center py-4">
              <svg className="h-12 w-12 text-gray-400 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <p className="text-gray-500">No workflows available</p>
            </div>
          ) : (
            <div className="space-y-2">
              {workflows.map(workflow => (
                <button
                  key={workflow.id}
                  onClick={() => setSelectedWorkflow(workflow)}
                  className={`w-full text-left p-3 rounded border transition-colors ${
                    selectedWorkflow?.id === workflow.id
                      ? 'bg-blue-50 border-blue-200'
                      : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  <div className="font-medium">{workflow.name}</div>
                  <div className="text-sm text-gray-600">Scope: {workflow.scope}</div>
                  <div className="text-xs text-gray-500">Version: {workflow.version}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Order Gating Warning */}
      {!selectedOrder && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
          <div className="flex items-center text-yellow-800">
            <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-semibold">Order Required</p>
              <p className="text-sm">Please select an order first. Workflows can only be processed with an existing order.</p>
            </div>
          </div>
        </div>
      )}

      {/* Selected Items Summary */}
      {(selectedOrder || selectedWorkflow) && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-blue-900 mb-2">Selected Items</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-blue-700">Order:</span>
              <span className="ml-2">
                {selectedOrder 
                  ? `#${selectedOrder.id.slice(0, 8)} (${selectedOrder.patient_name})`
                  : 'None selected'
                }
              </span>
            </div>
            <div>
              <span className="text-blue-700">Workflow:</span>
              <span className="ml-2">
                {selectedWorkflow ? selectedWorkflow.name : 'None selected'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Workflow Runner */}
      {selectedWorkflow && (
        <div className="bg-white rounded-lg shadow border">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-xl font-semibold">Workflow Execution</h2>
            <p className="text-gray-600 mt-1">
              {selectedOrder 
                ? `Processing workflow for order #${selectedOrder.id.slice(0, 8)}`
                : 'Workflow will be blocked without order selection'
              }
            </p>
          </div>
          <div className="p-6">
            <SimpleWorkflowRunner
              workflowDefinition={selectedWorkflow.definition}
              onComplete={handleWorkflowComplete}
              orderId={selectedOrder?.id} // Order gating - only pass if order selected
              testGroupId={selectedOrder?.test_group_name ? 'test-group-id' : undefined}
            />
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="mt-8 bg-gray-50 rounded-lg p-6">
        <h3 className="font-semibold mb-3">How to Test Order Gating</h3>
        <ol className="list-decimal list-inside space-y-2 text-sm text-gray-600">
          <li>Select an order from the left panel (required)</li>
          <li>Select a workflow from the right panel</li>
          <li>Try to complete the workflow - it will only work with an order selected</li>
          <li>If no order is selected, you'll see a blocking message</li>
          <li>Results will be properly linked to the selected order</li>
        </ol>
      </div>
    </div>
  )
}
