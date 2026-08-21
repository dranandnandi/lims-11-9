import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveWhatsAppSender, formatPhoneForSender } from '../_shared/whatsappSender.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface OrderRequest {
  patient_id: string;
  test_ids: string[];
  referring_doctor_id?: string;
  location_id?: string;
  discount_type?: 'percentage' | 'fixed';
  discount_value?: number;
  payment_method?: 'cash' | 'card' | 'upi' | 'online' | 'netbanking';
  amount_paid?: number;
  notes?: string;
  // Outsourcing config: { test_id: outsourced_lab_id | 'inhouse' }
  test_outsourcing?: Record<string, string>;
}

const COLOR_PALETTE: Array<{ hex: string; name: string }> = [
  { hex: '#EF4444', name: 'Red' },
  { hex: '#3B82F6', name: 'Blue' },
  { hex: '#10B981', name: 'Green' },
  { hex: '#F59E0B', name: 'Orange' },
  { hex: '#8B5CF6', name: 'Purple' },
  { hex: '#06B6D4', name: 'Cyan' },
  { hex: '#EC4899', name: 'Pink' },
  { hex: '#84CC16', name: 'Lime' },
  { hex: '#F97316', name: 'Amber' },
  { hex: '#6366F1', name: 'Indigo' },
  { hex: '#14B8A6', name: 'Teal' },
  { hex: '#A855F7', name: 'Violet' },
];

function getOrderAssignedColor(dailySequenceNumber: number): { color_code: string; color_name: string } {
  const colorIndex = (dailySequenceNumber - 1) % COLOR_PALETTE.length;
  const selectedColor = COLOR_PALETTE[colorIndex];

  return {
    color_code: selectedColor.hex,
    color_name: selectedColor.name,
  };
}

function generateOrderSampleId(date: Date, dailySequence: number, labCode?: string | null): string {
  const day = date.getDate().toString().padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  const sequence = dailySequence.toString().padStart(3, '0');
  const datePart = `${day}-${month}-${year}-${sequence}`;
  return labCode ? `${labCode}-${datePart}` : datePart;
}

function isSampleIdConflictError(error: any): boolean {
  return error?.code === '23505' &&
    String(error?.message || error?.details || '').includes('unique_sample_id_per_lab');
}

function getDailySequenceFromOrder(order: any): number {
  if (typeof order?.order_number === 'number' && Number.isFinite(order.order_number)) {
    return order.order_number;
  }

  const tail = String(order?.sample_id || '').match(/(?:^|[/-])(\d+)\s*$/)?.[1] || '';
  const parsed = parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function generateOrderQRCodeData(order: {
  id: string;
  patientId: string;
  sampleId: string;
  orderDate: string;
  colorCode: string;
  colorName: string;
}): string {
  return JSON.stringify({
    orderId: order.id,
    patientId: order.patientId,
    sampleId: order.sampleId,
    orderDate: order.orderDate,
    colorCode: order.colorCode,
    colorName: order.colorName,
    generated: new Date().toISOString(),
  });
}

// Edge functions run in UTC. Send window times are configured in IST (UTC+5:30).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function isWithinWindow(sendWindowStart?: string, sendWindowEnd?: string): boolean {
  const utcNow = Date.now();
  const istDate = new Date(utcNow + IST_OFFSET_MS);
  const currentMinutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();

  const [startHour, startMinute] = (sendWindowStart || '09:00:00').split(':').map(Number);
  const [endHour, endMinute] = (sendWindowEnd || '21:00:00').split(':').map(Number);
  const startMinutes = (startHour * 60) + startMinute;
  const endMinutes = (endHour * 60) + endMinute;

  console.log(`⏰ Window check: IST ${istDate.getUTCHours()}:${String(istDate.getUTCMinutes()).padStart(2,'0')}, minutes=${currentMinutes}, window=${startMinutes}-${endMinutes}`);

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function nextWindowStartIso(sendWindowStart?: string): string {
  const utcNow = Date.now();
  const [startHour, startMinute] = (sendWindowStart || '09:00:00').split(':').map(Number);
  // Calculate next window start in IST, then convert to UTC
  const nextIst = new Date(utcNow + IST_OFFSET_MS);
  nextIst.setUTCHours(startHour, startMinute, 0, 0);
  if (nextIst.getTime() <= utcNow + IST_OFFSET_MS) {
    nextIst.setUTCDate(nextIst.getUTCDate() + 1);
  }
  const nextUtc = new Date(nextIst.getTime() - IST_OFFSET_MS);

  return nextUtc.toISOString();
}


Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    // Get authenticated user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // Parse request
    const orderData: OrderRequest = await req.json();

    console.log('Creating order with payment:', orderData);

    // Validate required fields
    if (!orderData.patient_id || !orderData.test_ids || orderData.test_ids.length === 0) {
      throw new Error('patient_id and test_ids are required');
    }

    // Get user's lab_id
    const { data: userData, error: labError } = await supabaseClient
      .from('users')
      .select('lab_id')
      .eq('id', user.id)
      .single();

    if (labError || !userData) {
      throw new Error('Could not fetch user lab');
    }

    const labId = userData.lab_id;

    // Fetch test groups with base prices
    const { data: tests, error: testsError } = await supabaseClient
      .from('test_groups')
      .select('id, name, price')
      .in('id', orderData.test_ids);

    if (testsError || !tests || tests.length === 0) {
      throw new Error('Invalid test IDs');
    }

    // If location specified, fetch location-specific prices and location details
    let locationPrices: Record<string, { patient_price: number; lab_receivable: number | null }> = {};
    let locationDetails: { collection_percentage: number | null; receivable_type: string | null } | null = null;
    
    if (orderData.location_id) {
      // Fetch location details for collection_percentage fallback
      const { data: locData } = await supabaseClient
        .from('locations')
        .select('collection_percentage, receivable_type')
        .eq('id', orderData.location_id)
        .single();
      
      if (locData) {
        locationDetails = locData;
        console.log('📍 Location details:', locationDetails);
      }
      
      // Fetch location-specific prices
      const { data: locPrices, error: locPricesError } = await supabaseClient
        .from('location_test_prices')
        .select('test_group_id, patient_price, lab_receivable')
        .eq('location_id', orderData.location_id)
        .in('test_group_id', orderData.test_ids)
        .eq('is_active', true);

      if (!locPricesError && locPrices) {
        locPrices.forEach(lp => {
          if (lp.patient_price !== null && lp.patient_price !== undefined) {
            locationPrices[lp.test_group_id] = {
              patient_price: Number(lp.patient_price),
              lab_receivable: lp.lab_receivable !== null ? Number(lp.lab_receivable) : null
            };
          }
        });
        console.log('📍 Location prices found:', locationPrices);
      }
    }

    // Calculate subtotal using location price if available, otherwise base price
    const subtotal = tests.reduce((sum, test) => {
      const locPrice = locationPrices[test.id];
      const price = locPrice?.patient_price ?? test.price ?? 0;
      console.log(`Test ${test.name}: location price=${locPrice?.patient_price}, base price=${test.price}, using=${price}`);
      return sum + price;
    }, 0);

    console.log(`📊 Subtotal calculated: ₹${subtotal}`);

    // Calculate discount
    let discountAmount = 0;
    if (orderData.discount_type && orderData.discount_value) {
      if (orderData.discount_type === 'percentage') {
        discountAmount = (subtotal * orderData.discount_value) / 100;
      } else if (orderData.discount_type === 'fixed') {
        discountAmount = Math.min(orderData.discount_value, subtotal); // Can't discount more than subtotal
      }
    }

    const finalAmount = subtotal - discountAmount;

    const orderDate = new Date().toISOString().split('T')[0];
    const { data: labData } = await supabaseClient
      .from('labs')
      .select('code')
      .eq('id', labId)
      .maybeSingle();

    const { data: dailyOrders, error: sequenceError } = await supabaseClient
      .from('orders')
      .select('sample_id, order_number')
      .eq('lab_id', labId)
      .gte('order_date', orderDate)
      .lt(
        'order_date',
        new Date(new Date(orderDate).getTime() + 24 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0],
      );

    if (sequenceError) {
      throw new Error(`Failed to generate sample ID: ${sequenceError.message}`);
    }

    let dailySequence = Math.max(
      dailyOrders?.length || 0,
      ...(dailyOrders || []).map(getDailySequenceFromOrder),
    ) + 1;

    // 1. Create Order
    let order: any = null;
    let sampleId = '';
    let color_code = '';
    let color_name = '';
    let lastOrderError: any = null;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      sampleId = generateOrderSampleId(new Date(orderDate), dailySequence, labData?.code);
      const assignedColor = getOrderAssignedColor(dailySequence);
      color_code = assignedColor.color_code;
      color_name = assignedColor.color_name;

      const { data: insertedOrder, error: orderError } = await supabaseClient
        .from('orders')
        .insert({
          patient_id: orderData.patient_id,
          lab_id: labId,
          referring_doctor_id: orderData.referring_doctor_id,
          location_id: orderData.location_id,
          created_by: user.id,
          total_amount: subtotal,
          final_amount: finalAmount,
          order_date: orderDate,
          sample_id: sampleId,
          color_code,
          color_name,
          status: 'created',
        })
        .select()
        .single();

      if (!orderError) {
        order = insertedOrder;
        break;
      }

      lastOrderError = orderError;
      if (!isSampleIdConflictError(orderError)) {
        throw new Error(`Order creation failed: ${orderError.message}`);
      }

      dailySequence += 1;
    }

    if (!order) {
      throw new Error(
        lastOrderError
          ? 'Order creation failed: could not assign a unique sample ID. Please try again.'
          : 'Order creation failed',
      );
    }

    console.log('✅ Order created:', order.id);

    const qrCodeData = generateOrderQRCodeData({
      id: order.id,
      patientId: orderData.patient_id,
      sampleId,
      orderDate: order.order_date || orderDate,
      colorCode: color_code,
      colorName: color_name,
    });

    const { error: qrUpdateError } = await supabaseClient
      .from('orders')
      .update({ qr_code_data: qrCodeData })
      .eq('id', order.id);

    if (qrUpdateError) {
      console.warn('Failed to update qr_code_data:', qrUpdateError.message);
    }

    // 2. Create Order Tests
    const orderTests = orderData.test_ids.map((testId) => ({
      order_id: order.id,
      test_group_id: testId,
    }));

    const { error: orderTestsError } = await supabaseClient
      .from('order_tests')
      .insert(orderTests);

    if (orderTestsError) {
      // Rollback order
      await supabaseClient.from('orders').delete().eq('id', order.id);
      throw new Error(`Order tests insertion failed: ${orderTestsError.message}`);
    }

    console.log('✅ Order tests linked');

    // 2b. Auto-consume per_order and per_sample inventory items (non-blocking)
    try {
      const [perOrderResult, perSampleResult] = await Promise.all([
        supabaseClient.rpc('fn_inventory_consume_general', {
          p_lab_id: labId,
          p_scope: 'per_order',
          p_order_id: order.id,
          p_reason: 'Order created',
          p_user_id: user.id,
        }),
        supabaseClient.rpc('fn_inventory_consume_general', {
          p_lab_id: labId,
          p_scope: 'per_sample',
          p_order_id: order.id,
          p_reason: 'Sample collection',
          p_user_id: user.id,
        }),
      ]);

      const orderConsumed = perOrderResult.data?.items_consumed || 0;
      const sampleConsumed = perSampleResult.data?.items_consumed || 0;
      if (orderConsumed > 0 || sampleConsumed > 0) {
        console.log(`📦 Inventory consumed: ${orderConsumed} per_order + ${sampleConsumed} per_sample items`);
      }
    } catch (invErr) {
      console.warn('Inventory auto-consume on order creation failed (non-blocking):', invErr);
    }

    // Get patient name for invoice
    const { data: patient } = await supabaseClient
      .from('patients')
      .select('id, name, phone')
      .eq('id', orderData.patient_id)
      .single();

    const { data: orderTestsForNotification } = await supabaseClient
      .from('order_tests')
      .select('test_name')
      .eq('order_id', order.id);

    const { data: referringDoctorForNotification } = orderData.referring_doctor_id
      ? await supabaseClient
        .from('doctors')
        .select('id, name, phone')
        .eq('id', orderData.referring_doctor_id)
        .maybeSingle()
      : { data: null };

    // Trigger registration confirmation notification (non-blocking)
    try {
      const { data: notifSettings } = await supabaseClient
        .from('lab_notification_settings')
        .select('*')
        .eq('lab_id', labId)
        .maybeSingle();

      const shouldNotifyPatient = notifSettings?.auto_send_registration_confirmation && patient?.phone;
      const shouldNotifyDoctor = notifSettings?.auto_send_registration_to_doctor && referringDoctorForNotification?.phone;

      if (shouldNotifyPatient || shouldNotifyDoctor) {
        const withinWindow = isWithinWindow(notifSettings.send_window_start, notifSettings.send_window_end);
        const shouldQueueOutsideWindow = notifSettings.queue_outside_window !== false;
        const scheduledFor = withinWindow ? new Date().toISOString() : nextWindowStartIso(notifSettings.send_window_start);
        const testNames = orderTestsForNotification?.map((t) => t.test_name).join(', ') || 'Lab Tests';

        // Route registration messages through the branch the order was booked
        // at, falling back to the lab default.
        const sender = await resolveWhatsAppSender(supabaseClient, {
          labId,
          locationId: orderData.location_id,
        });

        const sendRegistrationMessage = async (phone: string, message: string) => {
          const NETLIFY_SEND_MESSAGE_URL = 'https://app.limsapp.in/.netlify/functions/whatsapp-send-message';
          const formattedPhone = formatPhoneForSender(phone, sender.countryCode);

          const response = await fetch(NETLIFY_SEND_MESSAGE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: sender.userId,
              phoneNumber: formattedPhone,
              message,
            }),
          });

          const resultText = await response.text();
          return {
            sent: response.ok,
            error: response.ok ? '' : resultText || `HTTP ${response.status}`,
          };
        };

        const enqueueRegistrationMessage = async (
          recipientType: 'patient' | 'doctor',
          recipientPhone: string,
          recipientName: string,
          recipientId: string,
          message: string,
          sendError: string,
        ) => {
          await supabaseClient
            .from('notification_queue')
            .insert({
              lab_id: labId,
              location_id: orderData.location_id,
              recipient_type: recipientType,
              recipient_phone: recipientPhone,
              recipient_name: recipientName,
              recipient_id: recipientId,
              trigger_type: 'order_registered',
              order_id: order.id,
              message_content: message,
              status: 'pending',
              scheduled_for: scheduledFor,
              last_error: sendError || 'Initial send failed',
            });
        };

        if (shouldNotifyPatient && patient) {
          const message = `Hello ${patient.name || 'Patient'}, your order ${order.order_display || order.id.slice(-6)} has been registered for ${testNames}. Thank you.`;
          let sent = false;
          let sendError = '';

          if (withinWindow && sender.userId) {
            const result = await sendRegistrationMessage(patient.phone, message);
            sent = result.sent;
            sendError = result.error;
          } else if (!withinWindow) {
            sendError = 'Outside send window';
          } else {
            sendError = 'No WhatsApp sender configured for this location or lab';
          }

          if (!sent && (withinWindow || shouldQueueOutsideWindow)) {
            await enqueueRegistrationMessage('patient', patient.phone, patient.name, patient.id, message, sendError);
          }
        }

        if (shouldNotifyDoctor && referringDoctorForNotification) {
          const message = `Hello Dr. ${referringDoctorForNotification.name || 'Doctor'}, a new order ${order.order_display || order.id.slice(-6)} has been registered for patient ${patient?.name || order.patient_name || 'Patient'}: ${testNames}. Thank you.`;
          let sent = false;
          let sendError = '';

          if (withinWindow && sender.userId) {
            const result = await sendRegistrationMessage(referringDoctorForNotification.phone, message);
            sent = result.sent;
            sendError = result.error;
          } else if (!withinWindow) {
            sendError = 'Outside send window';
          } else {
            sendError = 'No WhatsApp sender configured for this location or lab';
          }

          if (!sent && (withinWindow || shouldQueueOutsideWindow)) {
            await enqueueRegistrationMessage(
              'doctor',
              referringDoctorForNotification.phone,
              referringDoctorForNotification.name,
              referringDoctorForNotification.id,
              message,
              sendError,
            );
          }
        }
      }
    } catch (notifError) {
      console.error('Registration notification trigger failed (non-blocking):', notifError);
    }

    // 3. Generate Invoice Number
    const invoiceNumber = `INV-${Date.now()}-${order.id.substring(0, 8)}`;

    // 4. Create Invoice (using actual schema columns)
    const { data: invoice, error: invoiceError } = await supabaseClient
      .from('invoices')
      .insert({
        patient_id: orderData.patient_id,
        patient_name: patient?.name || 'Unknown',
        order_id: order.id,
        lab_id: labId,
        location_id: orderData.location_id,
        referring_doctor_id: orderData.referring_doctor_id,
        invoice_number: invoiceNumber,
        subtotal: subtotal,
        discount: discountAmount, // Schema uses 'discount' not 'discount_amount'
        total_discount: discountAmount,
        total_before_discount: subtotal,
        total_after_discount: finalAmount,
        tax: 0, // Required field
        total: finalAmount, // Schema uses 'total' not 'total_amount'
        amount_paid: orderData.amount_paid || 0,
        payment_method: orderData.payment_method,
        payment_type: 'self',
        invoice_type: 'patient',
        status: 'Draft', // Enum type
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
      })
      .select()
      .single();

    if (invoiceError) {
      console.error('Invoice creation failed:', invoiceError);
      // Don't rollback - invoice can be created later
    } else {
      console.log('✅ Invoice created:', invoice.id);
      
      // 5. Create Invoice Items
      // Fetch outsourced lab costs if any tests are outsourced
      let outsourcedCosts: Record<string, number> = {};
      const outsourcedTests = orderData.test_outsourcing 
        ? Object.entries(orderData.test_outsourcing)
            .filter(([_, labId]) => labId && labId !== 'inhouse')
            .map(([testId, labId]) => ({ testId, labId }))
        : [];
      
      if (outsourcedTests.length > 0) {
        const outsourcedLabIds = [...new Set(outsourcedTests.map(t => t.labId))];
        const { data: outsourcedPrices } = await supabaseClient
          .from('outsourced_lab_prices')
          .select('test_group_id, outsourced_lab_id, cost')
          .in('outsourced_lab_id', outsourcedLabIds)
          .in('test_group_id', orderData.test_ids);
        
        if (outsourcedPrices) {
          outsourcedPrices.forEach(op => {
            // Key by test_id for lookup
            outsourcedCosts[op.test_group_id] = op.cost;
          });
        }
        console.log('📦 Outsourced costs:', outsourcedCosts);
      }
      
      // Calculate location_receivable for each test
      const invoiceItems = tests.map(test => {
        const locPrice = locationPrices[test.id];
        const price = locPrice?.patient_price ?? test.price ?? 0;
        const outsourcedLabId = orderData.test_outsourcing?.[test.id];
        const isOutsourced = outsourcedLabId && outsourcedLabId !== 'inhouse';
        
        // Determine location_receivable
        let locationReceivable: number | null = null;
        if (orderData.location_id) {
          if (locPrice?.lab_receivable !== null && locPrice?.lab_receivable !== undefined) {
            // Use test-specific lab_receivable from location_test_prices
            locationReceivable = locPrice.lab_receivable;
          } else if (locationDetails?.receivable_type === 'own_center') {
            // Own center gets 100% of revenue
            locationReceivable = price;
          } else if (locationDetails?.receivable_type === 'percentage' && locationDetails?.collection_percentage) {
            // Calculate using collection_percentage
            locationReceivable = price * (locationDetails.collection_percentage / 100);
          }
        }
        
        return {
          invoice_id: invoice.id,
          test_name: test.name,
          price: price,
          quantity: 1,
          total: price,
          lab_id: labId,
          order_id: order.id,
          location_receivable: locationReceivable,
          outsourced_lab_id: isOutsourced ? outsourcedLabId : null,
          outsourced_cost: isOutsourced ? (outsourcedCosts[test.id] || null) : null,
        };
      });
      
      const { error: itemsError } = await supabaseClient
        .from('invoice_items')
        .insert(invoiceItems);
      
      if (itemsError) {
        console.error('Invoice items creation failed:', itemsError);
      } else {
        console.log(`✅ Created ${invoiceItems.length} invoice items`);
      }
    }

    // 6. Record Payment (if amount provided)
    let payment = null;
    let balanceDue = finalAmount;

    if (orderData.amount_paid && orderData.amount_paid > 0 && invoice) {
      const paymentAmount = Math.min(orderData.amount_paid, finalAmount);
      balanceDue = finalAmount - paymentAmount;

      const { data: paymentData, error: paymentError } = await supabaseClient
        .from('payments')
        .insert({
          invoice_id: invoice.id, // REQUIRED - schema has no order_id
          lab_id: labId,
          location_id: orderData.location_id,
          amount: paymentAmount,
          payment_method: orderData.payment_method || 'cash',
          payment_reference: `PAY-${Date.now()}`,
          notes: orderData.notes,
          received_by: user.id, // Schema uses 'received_by' not 'created_by'
        })
        .select()
        .single();

      if (paymentError) {
        console.error('Payment recording failed:', paymentError);
      } else {
        payment = paymentData;
        console.log('✅ Payment recorded:', payment.id);
      }
    }

    // Return success response
    return new Response(
      JSON.stringify({
        success: true,
        order_id: order.id,
        invoice_id: invoice?.id,
        payment_id: payment?.id,
        subtotal,
        discount_amount: discountAmount,
        final_amount: finalAmount,
        amount_paid: orderData.amount_paid || 0,
        balance_due: balanceDue,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        error: message,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    );
  }
});
