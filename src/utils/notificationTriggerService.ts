// Notification Trigger Service
// Handles auto-triggering WhatsApp notifications for reports, invoices, and registrations

import { supabase, database } from './supabase';
import { WhatsAppAPI } from './whatsappAPI';
import { replacePlaceholders, DEFAULT_TEMPLATES, TemplateData } from './whatsappTemplates';

// Types
export interface NotificationSettings {
  id: string;
  lab_id: string;
  auto_send_report_to_patient: boolean;
  auto_send_report_to_doctor: boolean;
  send_report_on_status: 'Approved' | 'Completed' | 'Delivered';
  auto_send_invoice_to_patient: boolean;
  auto_send_registration_confirmation: boolean;
  auto_send_registration_to_doctor: boolean;
  auto_send_loyalty_points: boolean;
  auto_send_loyalty_redemption: boolean;
  include_test_details_in_registration: boolean;
  include_invoice_in_registration: boolean;
  default_patient_channel: 'whatsapp' | 'email' | 'both';
  send_window_start: string;
  send_window_end: string;
  queue_outside_window: boolean;
  max_messages_per_patient_per_day: number;
  /** 'proper' = Title Case, 'upper' = ALL CAPS for patient & doctor names */
  name_case_format: 'proper' | 'upper';
  /** 'doctor_only' = send to doctor phone only; 'both' = doctor + hospital_phone */
  doctor_report_recipients: 'doctor_only' | 'both';
}

export interface QueuedNotification {
  id: string;
  lab_id: string;
  /** Branch the notification came from; picks that branch's WhatsApp sender at drain time. */
  location_id: string | null;
  recipient_type: 'patient' | 'doctor';
  recipient_phone: string;
  recipient_name: string | null;
  recipient_id: string | null;
  trigger_type: 'report_ready' | 'invoice_generated' | 'order_registered' | 'payment_reminder' | 'loyalty_points_earned' | 'loyalty_points_redeemed';
  order_id: string | null;
  report_id: string | null;
  invoice_id: string | null;
  template_id: string | null;
  message_content: string | null;
  attachment_url: string | null;
  attachment_type: string | null;
  status: 'pending' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'skipped';
  scheduled_for: string;
  sent_at: string | null;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  whatsapp_message_id: string | null;
}

// Helper: Check if current time is within send window
function isWithinSendWindow(settings: NotificationSettings): boolean {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startHour, startMinute] = (settings.send_window_start || '09:00:00').split(':').map(Number);
  const [endHour, endMinute] = (settings.send_window_end || '21:00:00').split(':').map(Number);
  const startMinutes = (startHour * 60) + startMinute;
  const endMinutes = (endHour * 60) + endMinute;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function getNextWindowStartIso(settings: NotificationSettings): string {
  const now = new Date();
  const [startHour, startMinute] = (settings.send_window_start || '09:00:00').split(':').map(Number);

  const nextStart = new Date(now);
  nextStart.setHours(startHour, startMinute, 0, 0);

  if (nextStart <= now) {
    nextStart.setDate(nextStart.getDate() + 1);
  }

  return nextStart.toISOString();
}

async function matchesRequiredReportStatus(
  reportId: string,
  requiredStatus: NotificationSettings['send_report_on_status'],
): Promise<boolean> {
  const { data: report } = await supabase
    .from('reports')
    .select('status, report_status')
    .eq('id', reportId)
    .maybeSingle();

  const currentStatus = (report?.report_status || report?.status || '').toLowerCase();
  return currentStatus === requiredStatus.toLowerCase();
}

// Helper: Format phone number for WhatsApp
function formatPhoneNumber(phone: string): string {
  if (!phone) return '';
  // Remove all non-numeric characters
  let cleaned = phone.replace(/\D/g, '');
  // Add India country code if not present
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  return cleaned;
}

function isDuplicateQueueError(error: any): boolean {
  return error?.code === '23505' || String(error?.message || '').toLowerCase().includes('duplicate');
}

/** Apply lab name_case_format to a name string */
export function formatName(name: string, format: 'proper' | 'upper' = 'proper'): string {
  if (!name) return name;
  if (format === 'upper') return name.toUpperCase();
  // Proper case: first letter of each word upper, rest lower
  return name.replace(/\S+/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

export const notificationTriggerService = {
  // Get lab notification settings
  getSettings: async (labId: string): Promise<NotificationSettings | null> => {
    const { data, error } = await supabase
      .from('lab_notification_settings')
      .select('*')
      .eq('lab_id', labId)
      .maybeSingle();
    
    if (error) {
      console.error('Error fetching notification settings:', error);
      return null;
    }
    return data;
  },

  // Create or update lab notification settings
  upsertSettings: async (labId: string, settings: Partial<NotificationSettings>) => {
    const { data, error } = await supabase
      .from('lab_notification_settings')
      .upsert({
        lab_id: labId,
        ...settings,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'lab_id' })
      .select()
      .single();
    
    return { data, error };
  },

  // Queue a notification
  queueNotification: async (notification: Partial<QueuedNotification>) => {
    const { data, error } = await supabase
      .from('notification_queue')
      .insert({
        ...notification,
        status: 'pending',
        scheduled_for: notification.scheduled_for || new Date().toISOString(),
        attempts: 0,
        max_attempts: 3,
      })
      .select()
      .single();
    
    return { data, error };
  },

  // Send notification immediately, queue on failure
  sendWithFallback: async (
    phone: string,
    message: string,
    attachmentUrl?: string,
    patientName?: string,
    testName?: string,
    /** Location the notification belongs to; picks that branch's WhatsApp sender. */
    locationId?: string | null
  ): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    try {
      const formattedPhone = formatPhoneNumber(phone);
      if (!formattedPhone) {
        return { success: false, error: 'Invalid phone number' };
      }

      let result;
      if (attachmentUrl) {
        // Send document with caption
        result = await WhatsAppAPI.sendReportFromUrl(
          formattedPhone,
          attachmentUrl,
          message,
          patientName,
          testName,
          locationId
        );
      } else {
        // Send text message
        result = await WhatsAppAPI.sendTextMessage(formattedPhone, message, undefined, locationId);
      }

      return {
        success: result.success,
        messageId: result.messageId,
        error: result.error || result.message,
      };
    } catch (error) {
      console.error('Error sending notification:', error);
      return { success: false, error: String(error) };
    }
  },

  // Triggered when report PDF is generated
  triggerReportReady: async (orderId: string, reportId: string, pdfUrl: string, labId: string) => {
    console.log(`[NotificationTrigger] Report ready: order=${orderId}, report=${reportId}`);
    
    // Get notification settings
    const settings = await notificationTriggerService.getSettings(labId);
    if (!settings) {
      console.log('[NotificationTrigger] No notification settings found for lab');
      return { sent: false, reason: 'no_settings' };
    }

    // Check if auto-send is enabled
    if (!settings.auto_send_report_to_patient && !settings.auto_send_report_to_doctor) {
      console.log('[NotificationTrigger] Auto-send disabled');
      return { sent: false, reason: 'disabled' };
    }

    const statusGate = settings.send_report_on_status || 'Completed';
    const statusMatches = await matchesRequiredReportStatus(reportId, statusGate);
    const withinWindow = isWithinSendWindow(settings);

    if (!statusMatches) {
      console.log(`[NotificationTrigger] Report status does not match configured trigger status (${statusGate})`);
    }

    if (!withinWindow) {
      console.log('[NotificationTrigger] Outside configured send window');
    }

    // Fetch order details with patient and doctor
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(`
        id,
        order_display,
        location_id,
        patient_name,
        doctor,
        referring_doctor_id,
        patients!inner (id, name, phone, email),
        doctors (id, name, phone, hospital_phone, email, report_delivery_method)
      `)
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      console.error('[NotificationTrigger] Error fetching order:', orderError);
      return { sent: false, reason: 'order_not_found' };
    }

    // Get test names
    const { data: orderTests } = await supabase
      .from('order_tests')
      .select('test_name')
      .eq('order_id', orderId);
    
    const testNames = orderTests?.map(t => t.test_name).join(', ') || 'Lab Test';

    // Get lab details
    const { data: lab } = await supabase
      .from('labs')
      .select('name, phone, address')
      .eq('id', labId)
      .single();

    const templateData: TemplateData = {
      PatientName: order.patient_name,
      PatientId: order.patients?.id,
      OrderId: order.id.slice(-6).toUpperCase(),
      OrderNumber: order.order_display || order.id.slice(-6),
      TestName: testNames,
      LabName: lab?.name || 'Lab',
      LabPhone: lab?.phone || '',
      DoctorName: order.doctors?.name || order.doctor,
    };

    const results: { patient?: any; doctor?: any } = {};
    const shouldAttemptNow = statusMatches && withinWindow;
    const scheduledFor = !withinWindow ? getNextWindowStartIso(settings) : new Date().toISOString();

    // Send to patient
    if (settings.auto_send_report_to_patient && order.patients?.phone) {
      const patientMessage = replacePlaceholders(
        DEFAULT_TEMPLATES.report_ready.message,
        templateData
      );

      const sendResult = shouldAttemptNow
        ? await notificationTriggerService.sendWithFallback(
          order.patients.phone,
          patientMessage,
          pdfUrl,
          order.patient_name,
          testNames,
          order.location_id
        )
        : { success: false, error: !statusMatches ? `Waiting for status ${statusGate}` : 'Outside send window' };

      if (sendResult.success) {
        // Update report tracking fields
        await supabase
          .from('reports')
          .update({
            whatsapp_sent_at: new Date().toISOString(),
            whatsapp_sent_to: order.patients.phone,
            whatsapp_sent_via: 'api',
          })
          .eq('id', reportId);
        
        results.patient = { sent: true, messageId: sendResult.messageId };
      } else {
        if (settings.queue_outside_window !== false || statusMatches) {
          await notificationTriggerService.queueNotification({
            lab_id: labId,
            location_id: order.location_id,
            recipient_type: 'patient',
            recipient_phone: order.patients.phone,
            recipient_name: order.patient_name,
            recipient_id: order.patients.id,
            trigger_type: 'report_ready',
            order_id: orderId,
            report_id: reportId,
            message_content: patientMessage,
            attachment_url: pdfUrl,
            attachment_type: 'report',
            scheduled_for: scheduledFor,
            last_error: sendResult.error,
          });
          results.patient = { sent: false, queued: true, error: sendResult.error };
        } else {
          results.patient = { sent: false, queued: false, skipped: true, reason: sendResult.error };
        }
      }
    }

    // Send to doctor (personal phone)
    if (settings.auto_send_report_to_doctor && order.doctors?.phone) {
      const doctorMessage = replacePlaceholders(
        DEFAULT_TEMPLATES.doctor_report_ready.message,
        templateData
      );

      const sendResult = shouldAttemptNow
        ? await notificationTriggerService.sendWithFallback(
          order.doctors.phone,
          doctorMessage,
          pdfUrl,
          order.patient_name,
          testNames,
          order.location_id
        )
        : { success: false, error: !statusMatches ? `Waiting for status ${statusGate}` : 'Outside send window' };

      if (sendResult.success) {
        await supabase
          .from('reports')
          .update({
            doctor_informed_at: new Date().toISOString(),
            doctor_informed_via: 'whatsapp',
          })
          .eq('id', reportId);
        results.doctor = { sent: true, messageId: sendResult.messageId };
      } else {
        if (settings.queue_outside_window !== false || statusMatches) {
          await notificationTriggerService.queueNotification({
            lab_id: labId,
            location_id: order.location_id,
            recipient_type: 'doctor',
            recipient_phone: order.doctors.phone,
            recipient_name: order.doctors.name,
            recipient_id: order.doctors.id,
            trigger_type: 'report_ready',
            order_id: orderId,
            report_id: reportId,
            message_content: doctorMessage,
            attachment_url: pdfUrl,
            attachment_type: 'report',
            scheduled_for: scheduledFor,
            last_error: sendResult.error,
          });
          results.doctor = { sent: false, queued: true, error: sendResult.error };
        } else {
          results.doctor = { sent: false, queued: false, skipped: true, reason: sendResult.error };
        }
      }
    }

    // Send to doctor hospital phone (if 'both' mode and hospital_phone exists)
    if (
      settings.auto_send_report_to_doctor &&
      settings.doctor_report_recipients === 'both' &&
      order.doctors?.hospital_phone
    ) {
      const doctorMessage = replacePlaceholders(
        DEFAULT_TEMPLATES.doctor_report_ready.message,
        templateData
      );

      const sendResult = shouldAttemptNow
        ? await notificationTriggerService.sendWithFallback(
          order.doctors.hospital_phone,
          doctorMessage,
          pdfUrl,
          order.patient_name,
          testNames,
          order.location_id
        )
        : { success: false, error: !statusMatches ? `Waiting for status ${statusGate}` : 'Outside send window' };

      if (!sendResult.success && (settings.queue_outside_window !== false || statusMatches)) {
        await notificationTriggerService.queueNotification({
          lab_id: labId,
          location_id: order.location_id,
          recipient_type: 'doctor',
          recipient_phone: order.doctors.hospital_phone,
          recipient_name: order.doctors.name,
          recipient_id: order.doctors.id,
          trigger_type: 'report_ready',
          order_id: orderId,
          report_id: reportId,
          message_content: doctorMessage,
          attachment_url: pdfUrl,
          attachment_type: 'report',
          scheduled_for: scheduledFor,
          last_error: sendResult.error,
        });
      }
    }

    console.log('[NotificationTrigger] Report ready results:', results);
    return { sent: true, results };
  },

  // Triggered when invoice PDF is generated
  triggerInvoiceGenerated: async (invoiceId: string, pdfUrl: string, labId: string) => {
    console.log(`[NotificationTrigger] Invoice generated: invoice=${invoiceId}`);

    const settings = await notificationTriggerService.getSettings(labId);
    if (!settings?.auto_send_invoice_to_patient) {
      return { sent: false, reason: 'disabled' };
    }

    const withinWindow = isWithinSendWindow(settings);
    const shouldAttemptNow = withinWindow;
    const scheduledFor = withinWindow ? new Date().toISOString() : getNextWindowStartIso(settings);

    // Fetch invoice with patient details
    const { data: invoice, error } = await supabase
      .from('invoices')
      .select(`
        id,
        invoice_number,
        total,
        patient_name,
        order_id,
        location_id,
        whatsapp_sent_at,
        patients!inner (id, name, phone)
      `)
      .eq('id', invoiceId)
      .single();

    if (error || !invoice) {
      return { sent: false, reason: 'invoice_not_found' };
    }

    if (invoice.whatsapp_sent_at) {
      return { sent: false, reason: 'already_sent' };
    }

    // Get lab details
    const { data: lab } = await supabase
      .from('labs')
      .select('name, phone')
      .eq('id', labId)
      .single();

    // Get order number
    const { data: order } = await supabase
      .from('orders')
      .select('order_display')
      .eq('id', invoice.order_id)
      .single();

    const templateData: TemplateData = {
      PatientName: invoice.patient_name,
      InvoiceNumber: invoice.invoice_number || invoiceId.slice(-6),
      OrderNumber: order?.order_display || invoice.order_id?.slice(-6) || '',
      Amount: String(invoice.total),
      LabName: lab?.name || 'Lab',
    };

    const message = replacePlaceholders(
      DEFAULT_TEMPLATES.invoice_generated.message,
      templateData
    );

    const queued = await notificationTriggerService.queueNotification({
      lab_id: labId,
      location_id: invoice.location_id,
      recipient_type: 'patient',
      recipient_phone: invoice.patients.phone,
      recipient_name: invoice.patient_name,
      recipient_id: invoice.patients.id,
      trigger_type: 'invoice_generated',
      invoice_id: invoiceId,
      message_content: message,
      attachment_url: pdfUrl,
      attachment_type: 'invoice',
      scheduled_for: scheduledFor,
      last_error: shouldAttemptNow ? null : 'Outside send window',
    });

    if (queued.error) {
      if (isDuplicateQueueError(queued.error)) {
        return { sent: false, queued: false, skipped: true, reason: 'duplicate_invoice_notification' };
      }
      return { sent: false, queued: false, error: queued.error.message || String(queued.error) };
    }

    if (!shouldAttemptNow) {
      if (settings.queue_outside_window !== false) {
        return { sent: false, queued: true, error: 'Outside send window' };
      }
      await supabase
        .from('notification_queue')
        .update({ status: 'skipped', last_error: 'Outside send window and queue disabled' })
        .eq('id', queued.data.id);
      return { sent: false, queued: false, skipped: true, reason: 'Outside send window' };
    }

    await supabase
      .from('notification_queue')
      .update({
        status: 'sending',
        attempts: 1,
      })
      .eq('id', queued.data.id);

    const sendResult = await notificationTriggerService.sendWithFallback(
      invoice.patients.phone,
      message,
      pdfUrl,
      invoice.patient_name,
      undefined,
      invoice.location_id
    );

    if (sendResult.success) {
      await supabase
        .from('invoices')
        .update({
          whatsapp_sent_at: new Date().toISOString(),
          whatsapp_sent_to: invoice.patients.phone,
          whatsapp_sent_via: 'api',
        })
        .eq('id', invoiceId);

      await supabase
        .from('notification_queue')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sendResult.messageId,
        })
        .eq('id', queued.data.id);
      
      return { sent: true, messageId: sendResult.messageId };
    }

    await supabase
      .from('notification_queue')
      .update({
        status: 'pending',
        last_error: sendResult.error,
      })
      .eq('id', queued.data.id);

    return { sent: false, queued: true, error: sendResult.error };
  },

  // Triggered when order is registered
  triggerOrderRegistered: async (orderId: string, labId: string) => {
    console.log(`[NotificationTrigger] Order registered: order=${orderId}`);

    const settings = await notificationTriggerService.getSettings(labId);
    if (!settings?.auto_send_registration_confirmation && !settings?.auto_send_registration_to_doctor) {
      return { sent: false, reason: 'disabled' };
    }

    const withinWindow = isWithinSendWindow(settings);
    const shouldAttemptNow = withinWindow;
    const scheduledFor = withinWindow ? new Date().toISOString() : getNextWindowStartIso(settings);

    // Fetch order with patient and tests
    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        id,
        order_display,
        location_id,
        patient_name,
        doctor,
        expected_date,
        patients!inner (id, name, phone),
        doctors (id, name, phone)
      `)
      .eq('id', orderId)
      .single();

    if (error || !order) {
      return { sent: false, reason: 'order_not_found' };
    }

    // Get test names
    const { data: orderTests } = await supabase
      .from('order_tests')
      .select('test_name')
      .eq('order_id', orderId);
    
    const testNames = orderTests?.map(t => t.test_name).join(', ') || 'Lab Tests';

    // Get lab details
    const { data: lab } = await supabase
      .from('labs')
      .select('name, phone')
      .eq('id', labId)
      .single();

    const templateData: TemplateData = {
      PatientName: order.patient_name,
      OrderNumber: order.order_display || order.id.slice(-6),
      TestName: testNames,
      ExpectedDate: order.expected_date ? new Date(order.expected_date).toLocaleDateString('en-IN') : 'To be determined',
      LabName: lab?.name || 'Lab',
      DoctorName: order.doctors?.name || order.doctor || 'Doctor',
    };

    // Try to use the lab's customized template from DB, fallback to hardcoded default
    let templateMessage = DEFAULT_TEMPLATES.registration_confirmation.message;
    try {
      const { data: dbTemplate } = await database.whatsappTemplates.getDefault('registration_confirmation', labId);
      if (dbTemplate?.message_content) {
        templateMessage = dbTemplate.message_content;
      }
    } catch (e) {
      console.warn('[NotificationTrigger] Failed to fetch DB template, using default:', e);
    }

    const message = replacePlaceholders(
      templateMessage,
      templateData
    );

    const results: { patient?: any; doctor?: any } = {};

    if (settings.auto_send_registration_confirmation && order.patients?.phone) {
      const sendResult = shouldAttemptNow
        ? await notificationTriggerService.sendWithFallback(
          order.patients.phone,
          message,
          undefined,
          undefined,
          undefined,
          order.location_id
        )
        : { success: false, error: 'Outside send window' };

      if (sendResult.success) {
        results.patient = { sent: true, messageId: sendResult.messageId };
      } else if (settings.queue_outside_window !== false) {
        await notificationTriggerService.queueNotification({
          lab_id: labId,
          location_id: order.location_id,
          recipient_type: 'patient',
          recipient_phone: order.patients.phone,
          recipient_name: order.patient_name,
          recipient_id: order.patients.id,
          trigger_type: 'order_registered',
          order_id: orderId,
          message_content: message,
          scheduled_for: scheduledFor,
          last_error: sendResult.error,
        });
        results.patient = { sent: false, queued: true, error: sendResult.error };
      } else {
        results.patient = { sent: false, queued: false, skipped: true, reason: sendResult.error };
      }
    }

    if (settings.auto_send_registration_to_doctor && order.doctors?.phone) {
      let doctorTemplateMessage = DEFAULT_TEMPLATES.doctor_registration_confirmation.message;
      try {
        const { data: dbTemplate } = await database.whatsappTemplates.getDefault('doctor_registration_confirmation', labId);
        if (dbTemplate?.message_content) {
          doctorTemplateMessage = dbTemplate.message_content;
        }
      } catch (e) {
        console.warn('[NotificationTrigger] Failed to fetch doctor DB template, using default:', e);
      }

      const doctorMessage = replacePlaceholders(doctorTemplateMessage, templateData);
      const sendResult = shouldAttemptNow
        ? await notificationTriggerService.sendWithFallback(
          order.doctors.phone,
          doctorMessage,
          undefined,
          undefined,
          undefined,
          order.location_id
        )
        : { success: false, error: 'Outside send window' };

      if (sendResult.success) {
        results.doctor = { sent: true, messageId: sendResult.messageId };
      } else if (settings.queue_outside_window !== false) {
        await notificationTriggerService.queueNotification({
          lab_id: labId,
          location_id: order.location_id,
          recipient_type: 'doctor',
          recipient_phone: order.doctors.phone,
          recipient_name: order.doctors.name,
          recipient_id: order.doctors.id,
          trigger_type: 'order_registered',
          order_id: orderId,
          message_content: doctorMessage,
          scheduled_for: scheduledFor,
          last_error: sendResult.error,
        });
        results.doctor = { sent: false, queued: true, error: sendResult.error };
      } else {
        results.doctor = { sent: false, queued: false, skipped: true, reason: sendResult.error };
      }
    }

    return { sent: true, results };
  },

  // Triggered when loyalty points are earned or redeemed
  triggerLoyaltyPoints: async (
    patientId: string,
    orderId: string,
    labId: string,
    eventType: 'earned' | 'redeemed',
    details: {
      points: number;
      balance: number;
      discountAmount?: number;
    },
  ) => {
    console.log(`[NotificationTrigger] Loyalty ${eventType}: patient=${patientId}, order=${orderId}`);

    const settings = await notificationTriggerService.getSettings(labId);
    const enabled = eventType === 'earned'
      ? settings?.auto_send_loyalty_points
      : settings?.auto_send_loyalty_redemption;

    if (!settings || !enabled) {
      return { sent: false, reason: 'disabled' };
    }

    const withinWindow = isWithinSendWindow(settings);
    const shouldAttemptNow = withinWindow;
    const scheduledFor = withinWindow ? new Date().toISOString() : getNextWindowStartIso(settings);

    const { data: patient, error: patientError } = await supabase
      .from('patients')
      .select('id, name, phone')
      .eq('id', patientId)
      .maybeSingle();

    if (patientError || !patient?.phone) {
      return { sent: false, reason: 'patient_phone_not_found' };
    }

    const { data: order } = await supabase
      .from('orders')
      .select('id, order_display, location_id')
      .eq('id', orderId)
      .maybeSingle();

    const { data: lab } = await supabase
      .from('labs')
      .select('name, phone, loyalty_point_value, loyalty_min_redeem_points')
      .eq('id', labId)
      .maybeSingle();

    const pointValue = Number(lab?.loyalty_point_value ?? 1);
    const category = eventType === 'earned' ? 'loyalty_points_earned' : 'loyalty_points_redeemed';
    const defaultTemplate = eventType === 'earned'
      ? DEFAULT_TEMPLATES.loyalty_points_earned
      : DEFAULT_TEMPLATES.loyalty_points_redeemed;

    let templateMessage = defaultTemplate.message;
    let templateId: string | null = null;
    try {
      const { data: dbTemplate } = await database.whatsappTemplates.getDefault(category, labId);
      if (dbTemplate?.message_content) {
        templateMessage = dbTemplate.message_content;
        templateId = dbTemplate.id;
      }
    } catch (e) {
      console.warn('[NotificationTrigger] Failed to fetch loyalty DB template, using default:', e);
    }

    const templateData: TemplateData = {
      PatientName: patient.name || 'Patient',
      PatientId: patient.id,
      PatientPhone: patient.phone,
      OrderId: order?.id?.slice(-6).toUpperCase() || orderId.slice(-6).toUpperCase(),
      OrderNumber: order?.order_display || orderId.slice(-6),
      LabName: lab?.name || 'Lab',
      LabPhone: lab?.phone || '',
      LoyaltyPointsEarned: eventType === 'earned' ? details.points : 0,
      LoyaltyPointsRedeemed: eventType === 'redeemed' ? details.points : 0,
      LoyaltyBalance: details.balance,
      LoyaltyValue: (details.balance * pointValue).toFixed(0),
      LoyaltyDiscountAmount: (details.discountAmount || 0).toFixed(2),
      LoyaltyMinRedeemPoints: lab?.loyalty_min_redeem_points || 100,
    };

    const message = replacePlaceholders(templateMessage, templateData);

    const sendResult = shouldAttemptNow
      ? await notificationTriggerService.sendWithFallback(
        patient.phone,
        message,
        undefined,
        undefined,
        undefined,
        order?.location_id
      )
      : { success: false, error: 'Outside send window' };

    if (sendResult.success) {
      return { sent: true, messageId: sendResult.messageId };
    }

    if (settings.queue_outside_window !== false) {
      await notificationTriggerService.queueNotification({
        lab_id: labId,
        location_id: order?.location_id,
        recipient_type: 'patient',
        recipient_phone: patient.phone,
        recipient_name: patient.name,
        recipient_id: patient.id,
        trigger_type: category,
        order_id: orderId,
        template_id: templateId,
        message_content: message,
        scheduled_for: scheduledFor,
        last_error: sendResult.error,
      });
      return { sent: false, queued: true, error: sendResult.error };
    }

    return { sent: false, queued: false, skipped: true, reason: sendResult.error };
  },

  // Process failed notifications in queue
  processQueue: async (labId?: string, limit: number = 10) => {
    console.log('[NotificationTrigger] Processing notification queue');

    let query = supabase
      .from('notification_queue')
      .select('*')
      .eq('status', 'pending')
      .lt('attempts', 3)
      .lte('scheduled_for', new Date().toISOString())
      .order('created_at', { ascending: true })
      .limit(limit);

    if (labId) {
      query = query.eq('lab_id', labId);
    }

    const { data: items, error } = await query;

    if (error || !items?.length) {
      return { processed: 0 };
    }

    let successCount = 0;
    let failCount = 0;

    for (const item of items) {
      const settings = await notificationTriggerService.getSettings(item.lab_id);
      if (settings && !isWithinSendWindow(settings)) {
        if (settings.queue_outside_window === false) {
          await supabase
            .from('notification_queue')
            .update({
              status: 'skipped',
              last_error: 'Outside send window and queue disabled',
            })
            .eq('id', item.id);
          continue;
        }

        await supabase
          .from('notification_queue')
          .update({
            scheduled_for: getNextWindowStartIso(settings),
            last_error: 'Deferred to next send window',
          })
          .eq('id', item.id);
        continue;
      }

      if (item.trigger_type === 'report_ready' && item.report_id && settings?.send_report_on_status) {
        const canSendByStatus = await matchesRequiredReportStatus(item.report_id, settings.send_report_on_status);
        if (!canSendByStatus) {
          await supabase
            .from('notification_queue')
            .update({
              scheduled_for: new Date(Date.now() + (30 * 60 * 1000)).toISOString(),
              last_error: `Waiting for report status ${settings.send_report_on_status}`,
            })
            .eq('id', item.id);
          continue;
        }
      }

      if (item.trigger_type === 'invoice_generated' && item.invoice_id) {
        const { data: invoiceStatus } = await supabase
          .from('invoices')
          .select('whatsapp_sent_at')
          .eq('id', item.invoice_id)
          .maybeSingle();

        if (invoiceStatus?.whatsapp_sent_at) {
          await supabase
            .from('notification_queue')
            .update({
              status: 'skipped',
              last_error: 'Invoice already sent via WhatsApp',
            })
            .eq('id', item.id);
          continue;
        }
      }

      // Mark as sending
      const { data: claimedItem, error: claimError } = await supabase
        .from('notification_queue')
        .update({ 
          status: 'sending',
          attempts: item.attempts + 1,
        })
        .eq('id', item.id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();

      if (claimError || !claimedItem) {
        continue;
      }

      const sendResult = await notificationTriggerService.sendWithFallback(
        item.recipient_phone,
        item.message_content || '',
        item.attachment_url || undefined,
        item.recipient_name || undefined,
        undefined,
        item.location_id
      );

      if (sendResult.success) {
        await supabase
          .from('notification_queue')
          .update({
            status: 'sent',
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sendResult.messageId,
          })
          .eq('id', item.id);
        successCount++;

        // Update tracking fields on related records
        if (item.report_id) {
          const updateField = item.recipient_type === 'doctor' 
            ? { doctor_informed_at: new Date().toISOString(), doctor_informed_via: 'whatsapp' }
            : { whatsapp_sent_at: new Date().toISOString(), whatsapp_sent_to: item.recipient_phone, whatsapp_sent_via: 'api' };
          
          await supabase.from('reports').update(updateField).eq('id', item.report_id);
        }
        if (item.invoice_id) {
          await supabase
            .from('invoices')
            .update({
              whatsapp_sent_at: new Date().toISOString(),
              whatsapp_sent_to: item.recipient_phone,
              whatsapp_sent_via: 'api',
            })
            .eq('id', item.invoice_id);
        }
      } else {
        const newStatus = item.attempts + 1 >= item.max_attempts ? 'failed' : 'pending';
        await supabase
          .from('notification_queue')
          .update({
            status: newStatus,
            last_error: sendResult.error,
          })
          .eq('id', item.id);
        failCount++;
      }
    }

    console.log(`[NotificationTrigger] Queue processed: ${successCount} sent, ${failCount} failed`);
    return { processed: items.length, sent: successCount, failed: failCount };
  },
};

export default notificationTriggerService;
