// Auto-Dispatch Analyzer
// Triggered by Supabase webhook on orders INSERT (or UPDATE when sample is collected).
// Reads each test group's linked analyzer_connection_id, groups tests by analyzer,
// and calls dispatch-order-to-analyzer for each group automatically.

import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Accept both direct calls { order_id } and Supabase webhook format { record: { id } }
    const body = await req.json()
    const order = body.record ?? body
    const orderId: string = order.id ?? body.order_id

    if (!orderId) {
      return new Response(JSON.stringify({ error: 'Missing order_id' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      })
    }

    // 1. Fetch full order with patient and sample barcode
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .select(`
        id, lab_id, patient_id, priority, order_number,
        sample_id,
        patients(name, date_of_birth, gender),
        samples(barcode, sample_type),
        labs!inner(lab_interface_enabled)
      `)
      .eq('id', orderId)
      .single()

    if (orderError || !orderData) {
      throw new Error(`Order not found: ${orderId}`)
    }

    // Gate: only process labs with lab_interface_enabled = true
    if (!(orderData as any).labs?.lab_interface_enabled) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Lab interface not enabled for this lab. Upgrade to activate analyzer auto-dispatch.',
        order_id: orderId,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Only use the physical tube barcode from samples.barcode — no fallbacks.
    // Using a non-numeric fallback (e.g. LIMS sample_id) causes the analyzer to echo
    // that string back in the ORU result, which then matches the wrong sample in the DB.
    const samplesArr: { barcode: string; sample_type?: string | null }[] = Array.isArray((orderData as any).samples)
      ? (orderData as any).samples
      : (orderData as any).samples ? [(orderData as any).samples] : []
    let sampleBarcode: string | null = samplesArr.find((s) => s.barcode)?.barcode ?? null
    let collectedSampleType: string | null =
      samplesArr.find((s) => s.barcode === sampleBarcode)?.sample_type ?? null

    // If barcode not yet set (sample not yet printed/scanned), retry once after 4 s.
    // The DB trigger fn_dispatch_on_barcode_set will re-queue when barcode is assigned.
    if (!sampleBarcode) {
      await new Promise((r) => setTimeout(r, 4000))
      const { data: freshSamples } = await supabase
        .from('samples')
        .select('barcode, sample_type')
        .eq('order_id', orderId)
        .not('barcode', 'is', null)
        .limit(1)
      sampleBarcode = freshSamples?.[0]?.barcode ?? null
      collectedSampleType = freshSamples?.[0]?.sample_type ?? null
    }

    // Still no barcode — abort. The DB trigger will dispatch when barcode is set.
    if (!sampleBarcode) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Sample barcode not yet assigned. Dispatch will be triggered automatically when the barcode is set.',
        order_id: orderId,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const patient = (orderData as any).patients
    const priority = orderData.priority === 'STAT' ? 1 : 5

    // 2a. Fetch via order_test_groups (legacy / panel pathway)
    const { data: otgRows, error: otgError } = await supabase
      .from('order_test_groups')
      .select(`
        id,
        test_group_id,
        test_groups!inner(
          id, code, name, sample_type, analyzer_connection_id
        )
      `)
      .eq('order_id', orderId)
      .not('test_groups.analyzer_connection_id', 'is', null)

    if (otgError) throw new Error(`order_test_groups query failed: ${otgError.message}`)

    // 2b. Fetch via order_tests (primary pathway — test_group_id FK → test_groups)
    const { data: otRows, error: otError } = await supabase
      .from('order_tests')
      .select(`
        id,
        test_group_id,
        test_groups!inner(
          id, code, name, sample_type, analyzer_connection_id
        )
      `)
      .eq('order_id', orderId)
      .eq('is_canceled', false)
      .not('test_groups.analyzer_connection_id', 'is', null)

    if (otError) throw new Error(`order_tests query failed: ${otError.message}`)

    // Normalise both sources into a common shape
    type TGLink = {
      rowId: string
      tgId: string
      tg: { id: string; code: string; name: string; sample_type?: string | null; analyzer_connection_id: string }
    }

    const allLinks: TGLink[] = [
      ...(otgRows ?? []).map((r: any) => ({ rowId: r.id, tgId: r.test_group_id, tg: r.test_groups })),
      ...(otRows ?? []).map((r: any) => ({ rowId: r.id, tgId: r.test_group_id, tg: r.test_groups })),
    ]

    // De-duplicate by test_group_id (same panel can appear in both tables)
    const seenTGIds = new Set<string>()
    const uniqueLinks: TGLink[] = allLinks.filter((l) => {
      if (seenTGIds.has(l.tgId)) return false
      seenTGIds.add(l.tgId)
      return true
    })

    if (uniqueLinks.length === 0) {
      // Race condition: order_tests may not be inserted yet (webhook fires on orders INSERT).
      // Wait 4 seconds and retry once before giving up.
      await new Promise((r) => setTimeout(r, 4000))

      const { data: otRowsRetry } = await supabase
        .from('order_tests')
        .select(`id, test_group_id, test_groups!inner(id, code, name, sample_type, analyzer_connection_id)`)
        .eq('order_id', orderId)
        .eq('is_canceled', false)
        .not('test_groups.analyzer_connection_id', 'is', null)

      const { data: otgRowsRetry } = await supabase
        .from('order_test_groups')
        .select(`id, test_group_id, test_groups!inner(id, code, name, sample_type, analyzer_connection_id)`)
        .eq('order_id', orderId)
        .not('test_groups.analyzer_connection_id', 'is', null)

      const retryLinks: TGLink[] = [
        ...(otgRowsRetry ?? []).map((r: any) => ({ rowId: r.id, tgId: r.test_group_id, tg: r.test_groups })),
        ...(otRowsRetry ?? []).map((r: any) => ({ rowId: r.id, tgId: r.test_group_id, tg: r.test_groups })),
      ].filter((l) => {
        if (seenTGIds.has(l.tgId)) return false
        seenTGIds.add(l.tgId)
        return true
      })

      if (retryLinks.length === 0) {
        return new Response(JSON.stringify({
          success: true,
          message: 'No test groups with analyzer_connection_id configured — nothing to dispatch.',
          order_id: orderId,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      uniqueLinks.push(...retryLinks)
    }

    // 3. Fetch lab_analytes for all test groups (via test_group_analytes)
    const allTestGroupIds = uniqueLinks.map((l) => l.tgId)
    const { data: tgaRows, error: tgaError } = await supabase
      .from('test_group_analytes')
      .select(`
        test_group_id,
        lab_analyte_id,
        lab_analytes!inner(id, code, name, analyte_id)
      `)
      .in('test_group_id', allTestGroupIds)
      .eq('lab_analytes.is_active', true)

    if (tgaError) throw new Error(`test_group_analytes query failed: ${tgaError.message}`)

    // Build map: test_group_id → lab_analyte info[]
    const tgToLabAnalytes = new Map<string, Array<{ lab_analyte_id: string; code: string; name: string }>>()
    const seenLabAnalytesByGroup = new Set<string>()
    for (const row of tgaRows ?? []) {
      const la = (row as any).lab_analytes
      if (!la || !row.lab_analyte_id) continue
      const dedupeKey = `${row.test_group_id}:${row.lab_analyte_id}`
      if (seenLabAnalytesByGroup.has(dedupeKey)) continue
      seenLabAnalytesByGroup.add(dedupeKey)
      const list = tgToLabAnalytes.get(row.test_group_id) ?? []
      list.push({
        lab_analyte_id: row.lab_analyte_id,
        code: la.code || la.name,
        name: la.name,
      })
      tgToLabAnalytes.set(row.test_group_id, list)
    }

    // 4. Group by analyzer_connection_id with lab_analyte details
    const byAnalyzer = new Map<string, {
      tests: string[]
      testGroupIds: string[]
      sampleTypes: string[]
      labAnalytes: Array<{
        lab_analyte_id: string
        code: string
        name: string
        test_group_id: string
        sample_type: string
      }>
    }>()

    for (const link of uniqueLinks) {
      const tg = link.tg
      const connId: string = tg.analyzer_connection_id
      const code: string = tg.code || tg.name

      if (!byAnalyzer.has(connId)) {
        byAnalyzer.set(connId, { tests: [], testGroupIds: [], sampleTypes: [], labAnalytes: [] })
      }
      const group = byAnalyzer.get(connId)!
      group.tests.push(code)
      group.testGroupIds.push(tg.id)
      const sampleType = collectedSampleType || tg.sample_type || ''
      if (sampleType) group.sampleTypes.push(sampleType)

      // Add lab_analytes for this test_group
      const labAnalytesForTg = tgToLabAnalytes.get(tg.id) ?? []
      for (const la of labAnalytesForTg) {
        group.labAnalytes.push({ ...la, test_group_id: tg.id, sample_type: sampleType })
      }
    }

    // 4a. Fetch connection configs to honour receive-only (inbound) analyzers.
    // A connection marked config.direction = 'receive_only' must never have an
    // order/worklist staged for it — results are still ingested by barcode.
    const analyzerConnectionIds = [...byAnalyzer.keys()]
    const { data: connRows } = await supabase
      .from('analyzer_connections')
      .select('id, config')
      .in('id', analyzerConnectionIds)

    const receiveOnly = new Set(
      (connRows ?? [])
        .filter((c: any) => c.config?.direction === 'receive_only')
        .map((c: any) => c.id)
    )

    // 4. Check for existing queue entries to avoid double-dispatch
    const { data: existingQueue } = await supabase
      .from('analyzer_order_queue')
      .select('analyzer_connection_id')
      .eq('order_id', orderId)
      .in('status', ['pending', 'mapped', 'sending', 'sent', 'acknowledged'])

    const alreadyDispatched = new Set(
      (existingQueue ?? []).map((q: any) => q.analyzer_connection_id)
    )

    // 5. Dispatch to each analyzer
    const results: any[] = []

    for (const [analyzerConnectionId, group] of byAnalyzer) {
      if (receiveOnly.has(analyzerConnectionId)) {
        results.push({
          analyzer_connection_id: analyzerConnectionId,
          skipped: true,
          reason: 'Receive-only analyzer — orders are not sent to this instrument',
        })
        continue
      }

      if (alreadyDispatched.has(analyzerConnectionId)) {
        results.push({
          analyzer_connection_id: analyzerConnectionId,
          skipped: true,
          reason: 'Already queued',
        })
        continue
      }

      try {
        const { data: dispatchResult, error: dispatchError } = await supabase.functions.invoke(
          'dispatch-order-to-analyzer',
          {
            headers: {
              Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''}`,
            },
            body: {
              order_id: orderId,
              sample_barcode: sampleBarcode,
              analyzer_connection_id: analyzerConnectionId,
              tests: group.tests,
              lab_analytes: group.labAnalytes,
              sample_type: group.sampleTypes[0] || collectedSampleType || undefined,
              patient: patient
                ? {
                    name: patient.name ?? '',
                    dob: patient.date_of_birth || null,
                    gender: patient.gender ?? '',
                  }
                : undefined,
              priority,
            },
          }
        )

        if (dispatchError) {
          // Try to extract the actual error message from the response body
          const errBody = (dispatchResult as any)
          console.error(`dispatch-order-to-analyzer FAILED:`, JSON.stringify(dispatchError), `body:`, JSON.stringify(errBody))
          throw new Error(`dispatch failed: ${JSON.stringify(dispatchError)} body: ${JSON.stringify(errBody)}`)
        }

        results.push({
          analyzer_connection_id: analyzerConnectionId,
          tests: group.tests,
          ...dispatchResult,
        })

        console.log(`✅ Dispatched order ${orderId} to analyzer ${analyzerConnectionId}: ${group.tests.join(', ')}`)
      } catch (err: any) {
        console.error(`❌ Failed to dispatch to analyzer ${analyzerConnectionId}:`, err.message)
        results.push({
          analyzer_connection_id: analyzerConnectionId,
          tests: group.tests,
          error: err.message,
        })
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        order_id: orderId,
        sample_barcode: sampleBarcode,
        dispatched_to: results.length,
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error: any) {
    console.error('Auto-dispatch error:', error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
