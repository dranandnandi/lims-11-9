// Supabase Edge Function: Process Notification Queue
// Processes failed/pending WhatsApp notifications and retries sending

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4'
import { resolveWhatsAppSender, formatPhoneForSender } from '../_shared/whatsappSender.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const WHATSAPP_API_BASE = Deno.env.get('WHATSAPP_API_BASE_URL') || 'https://app.limsapp.in/whatsapp'

// Edge functions run in UTC. Send window times are configured in IST (UTC+5:30).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

function isWithinWindow(sendWindowStart?: string, sendWindowEnd?: string): boolean {
  const utcNow = Date.now()
  const istDate = new Date(utcNow + IST_OFFSET_MS)
  const currentMinutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes()

  const [startHour, startMinute] = (sendWindowStart || '09:00:00').split(':').map(Number)
  const [endHour, endMinute] = (sendWindowEnd || '21:00:00').split(':').map(Number)
  const startMinutes = (startHour * 60) + startMinute
  const endMinutes = (endHour * 60) + endMinute

  console.log(`⏰ Window check: IST ${istDate.getUTCHours()}:${String(istDate.getUTCMinutes()).padStart(2,'0')}, minutes=${currentMinutes}, window=${startMinutes}-${endMinutes}`)

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes
}

function nextWindowStartIso(sendWindowStart?: string): string {
  const utcNow = Date.now()
  const [startHour, startMinute] = (sendWindowStart || '09:00:00').split(':').map(Number)
  // Calculate next window start in IST, then convert to UTC
  const nextIst = new Date(utcNow + IST_OFFSET_MS)
  nextIst.setUTCHours(startHour, startMinute, 0, 0)
  if (nextIst.getTime() <= utcNow + IST_OFFSET_MS) {
    nextIst.setUTCDate(nextIst.getUTCDate() + 1)
  }
  const nextUtc = new Date(nextIst.getTime() - IST_OFFSET_MS)

  return nextUtc.toISOString()
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseClient = createClient(supabaseUrl, supabaseKey)

    // Parse request body for optional lab_id filter
    let labId: string | undefined
    let limit = 10
    
    try {
      const body = await req.json()
      labId = body.labId
      limit = body.limit || 10
    } catch {
      // No body or invalid JSON, use defaults
    }

    console.log('📲 Processing notification queue...')
    console.log('Lab filter:', labId || 'All labs')
    console.log('Limit:', limit)

    // Fetch pending notifications that are ready for retry
    let query = supabaseClient
      .from('notification_queue')
      .select('*')
      .eq('status', 'pending')
      .lt('attempts', 3)
      .lte('scheduled_for', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(limit)

    if (labId) {
      query = query.eq('lab_id', labId)
    }

    const { data: items, error: fetchError } = await query

    if (fetchError) {
      throw new Error(`Failed to fetch queue items: ${fetchError.message}`)
    }

    if (!items?.length) {
      console.log('📭 No pending notifications to process')
      return new Response(
        JSON.stringify({ 
          success: true, 
          processed: 0, 
          sent: 0, 
          failed: 0,
          message: 'No pending notifications' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`📬 Found ${items.length} pending notifications`)

    // Use existing Netlify function for sending reports
    const NETLIFY_SEND_REPORT_URL = 'https://app.limsapp.in/.netlify/functions/send-report-url'
    const NETLIFY_SEND_MESSAGE_URL = 'https://app.limsapp.in/.netlify/functions/whatsapp-send-message'

    // Helper function to send WhatsApp via Netlify function
    const sendWhatsApp = async (item: any): Promise<boolean> => {
      try {
        // Route to the branch's own WhatsApp number when the originating
        // location has one; otherwise fall through to the lab default.
        const sender = await resolveWhatsAppSender(supabaseClient, {
          labId: item.lab_id,
          locationId: item.location_id,
        })

        const whatsappUserId = sender.userId
        const countryCode = sender.countryCode

        if (!whatsappUserId) {
          console.error('❌ No WhatsApp sender configured for lab:', item.lab_id, 'location:', item.location_id)
          return false
        }

        console.log(`✅ Sender ${whatsappUserId} via ${sender.source}`)
        console.log('🌍 Using country code:', countryCode)

        const formattedPhone = formatPhoneForSender(item.recipient_phone, countryCode)

        console.log(`📤 Sending to ${formattedPhone} (original: ${item.recipient_phone})`)

        if (item.attachment_url) {
          // Send document via Netlify function
          console.log(`   Using Netlify function: ${NETLIFY_SEND_REPORT_URL}`)
          console.log(`   File URL: ${item.attachment_url}`)
          
          // Extract filename from URL
          const urlParts = item.attachment_url.split('/')
          const fileName = urlParts[urlParts.length - 1]
          
          const requestBody = {
            userId: whatsappUserId,
            fileUrl: item.attachment_url,
            fileName: fileName,
            caption: item.message_content || '',
            phoneNumber: formattedPhone,
            templateData: {
              PatientName: item.recipient_name || 'Patient'
            }
          }
          
          console.log('📋 Request payload:', JSON.stringify(requestBody, null, 2))
          
          const response = await fetch(NETLIFY_SEND_REPORT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          })
          
          const responseText = await response.text()
          
          if (!response.ok) {
            console.error(`❌ Netlify function error: ${response.status} ${response.statusText}`)
            console.error(`   Response: ${responseText}`)
            return false
          }
          
          try {
            const result = JSON.parse(responseText)
            console.log(`✅ WhatsApp sent successfully:`, result)
          } catch {
            console.log(`✅ WhatsApp sent (raw response): ${responseText}`)
          }
          return true
        } else {
          // Send text message via Netlify function
          const requestBody = {
            userId: whatsappUserId,
            phoneNumber: formattedPhone,
            message: item.message_content || '',
            templateData: {
              PatientName: item.recipient_name || 'Patient'
            }
          }

          const response = await fetch(NETLIFY_SEND_MESSAGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          })

          const responseText = await response.text()
          if (!response.ok) {
            console.error(`❌ Netlify text function error: ${response.status} ${response.statusText}`)
            console.error(`   Response: ${responseText}`)
            return false
          }

          try {
            const result = JSON.parse(responseText)
            console.log(`✅ Text WhatsApp sent successfully:`, result)
          } catch {
            console.log(`✅ Text WhatsApp sent (raw response): ${responseText}`)
          }
          return true
        }
      } catch (error) {
        console.error(`❌ WhatsApp send exception:`, error)
        return false
      }
    }

    let successCount = 0
    let failCount = 0

    for (const item of items) {
      console.log(`\n📤 Processing: ${item.id} (${item.trigger_type} → ${item.recipient_type})`)

      const { data: settings } = await supabaseClient
        .from('lab_notification_settings')
        .select('send_window_start, send_window_end, queue_outside_window, send_report_on_status')
        .eq('lab_id', item.lab_id)
        .maybeSingle()

      if (settings && !isWithinWindow(settings.send_window_start, settings.send_window_end)) {
        if (settings.queue_outside_window === false) {
          await supabaseClient
            .from('notification_queue')
            .update({
              status: 'skipped',
              last_error: 'Outside send window and queue disabled',
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id)
          continue
        }

        await supabaseClient
          .from('notification_queue')
          .update({
            scheduled_for: nextWindowStartIso(settings.send_window_start),
            last_error: 'Deferred to next send window',
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id)
        continue
      }

      if (item.trigger_type === 'report_ready' && item.report_id && settings?.send_report_on_status) {
        const { data: report } = await supabaseClient
          .from('reports')
          .select('status, report_status')
          .eq('id', item.report_id)
          .maybeSingle()

        const currentStatus = (report?.report_status || report?.status || '').toLowerCase()
        const requiredStatus = String(settings.send_report_on_status).toLowerCase()

        if (currentStatus !== requiredStatus) {
          await supabaseClient
            .from('notification_queue')
            .update({
              scheduled_for: new Date(Date.now() + (30 * 60 * 1000)).toISOString(),
              last_error: `Waiting for report status ${settings.send_report_on_status}`,
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id)
          continue
        }
      }

      if (item.trigger_type === 'invoice_generated' && item.invoice_id) {
        const { data: invoiceStatus } = await supabaseClient
          .from('invoices')
          .select('whatsapp_sent_at')
          .eq('id', item.invoice_id)
          .maybeSingle()

        if (invoiceStatus?.whatsapp_sent_at) {
          await supabaseClient
            .from('notification_queue')
            .update({
              status: 'skipped',
              last_error: 'Invoice already sent via WhatsApp',
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id)
          continue
        }
      }

      // Mark as sending
      const { data: claimedItem, error: claimError } = await supabaseClient
        .from('notification_queue')
        .update({ 
          status: 'sending',
          attempts: item.attempts + 1,
          updated_at: new Date().toISOString()
        })
        .eq('id', item.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle()

      if (claimError || !claimedItem) {
        continue
      }

      try {
        const sent = await sendWhatsApp(item)

        if (sent) {
          // Mark as sent
          await supabaseClient
            .from('notification_queue')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id)

          // Update tracking fields on related records
          if (item.report_id) {
            const updateField = item.recipient_type === 'doctor' 
              ? { doctor_informed_at: new Date().toISOString(), doctor_informed_via: 'whatsapp' }
              : { whatsapp_sent_at: new Date().toISOString(), whatsapp_sent_to: item.recipient_phone, whatsapp_sent_via: 'api' }
            
            await supabaseClient.from('reports').update(updateField).eq('id', item.report_id)
          }
          if (item.invoice_id) {
            await supabaseClient
              .from('invoices')
              .update({
                whatsapp_sent_at: new Date().toISOString(),
                whatsapp_sent_to: item.recipient_phone,
                whatsapp_sent_via: 'api'
              })
              .eq('id', item.invoice_id)
          }

          console.log(`✅ Sent successfully`)
          successCount++

        } else {
          // Mark as failed or pending for retry
          const newStatus = item.attempts + 1 >= 3 ? 'failed' : 'pending'
          await supabaseClient
            .from('notification_queue')
            .update({
              status: newStatus,
              last_error: 'Send request returned non-OK status',
              updated_at: new Date().toISOString()
            })
            .eq('id', item.id)

          console.log(`❌ Failed to send (attempt ${item.attempts + 1}/3)`)
          failCount++
        }

      } catch (sendError) {
        // Mark as failed or pending for retry
        const newStatus = item.attempts + 1 >= 3 ? 'failed' : 'pending'
        await supabaseClient
          .from('notification_queue')
          .update({
            status: newStatus,
            last_error: String(sendError),
            updated_at: new Date().toISOString()
          })
          .eq('id', item.id)

        console.error(`❌ Error sending:`, sendError)
        failCount++
      }
    }

    console.log(`\n📊 Queue processing complete: ${successCount} sent, ${failCount} failed`)

    return new Response(
      JSON.stringify({
        success: true,
        processed: items.length,
        sent: successCount,
        failed: failCount
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('❌ Queue processor error:', error)
    
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: 'Queue processing failed', 
        details: String(error) 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
