import { createClient } from '@supabase/supabase-js';
import { generateOrderSampleId, getOrderAssignedColor, generateOrderQRCodeData } from './colorAssignment';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// File upload utilities
export const uploadFile = async (
  file: File, 
  filePath: string, 
  options?: { upsert?: boolean }
) => {
  const { data, error } = await supabase.storage
    .from('attachments')
    .upload(filePath, file, {
      upsert: options?.upsert || false,
      contentType: file.type
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  // Get public URL
  const { data: publicUrlData } = supabase.storage
    .from('attachments')
    .getPublicUrl(data.path);

  return {
    path: data.path,
    publicUrl: publicUrlData.publicUrl,
    fullPath: data.fullPath
  };
};

// Generate organized file path
export const generateFilePath = (
  fileName: string,
  patientId?: string,
  labId?: string,
  category: string = 'general'
): string => {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  if (labId && patientId) {
    return `${category}/${labId}/${patientId}_${timestamp}_${sanitizedFileName}`;
  } else if (patientId) {
    return `${category}/${patientId}_${timestamp}_${sanitizedFileName}`;
  } else {
    return `${category}/${timestamp}_${sanitizedFileName}`;
  }
};

// Auth helper functions
export const auth = {
  signUp: async (email: string, password: string, userData?: any) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: userData
      }
    });
    return { data, error };
  },

  signIn: async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });
    return { data, error };
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  },

  getCurrentUser: async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    return { user, error };
  },

  getSession: async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
    return { session, error };
  }
};

// Database helper functions for patients
export const database = { 
  // Helper to get current user's lab ID
  getCurrentUserLabId: async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      console.error('Error fetching user:', error);
      return null;
    }
    
    // Primary: Check users table for lab_id (most reliable)
    try {
      const { data: userData, error: userDataError } = await supabase
        .from('users')
        .select('lab_id')
        .eq('email', user.email) // Match by email since auth.users.id might be different from public.users.id
        .eq('status', 'Active')
        .single();
      
      if (!userDataError && userData?.lab_id) {
        return userData.lab_id;
      }
    } catch (err) {
      console.warn('Could not fetch lab_id from users table:', err);
    }
    
    // Secondary: Check if lab_id is in user metadata (fallback)
    if (user?.user_metadata?.lab_id) {
      console.warn('Using lab_id from user metadata (consider updating users table):', user.user_metadata.lab_id);
      return user.user_metadata.lab_id;
    }
    
    // Tertiary: Check user_labs table for user-lab assignment (if exists)
    try {
      const { data: userLab, error: userLabError } = await supabase
        .from('user_labs')
        .select('lab_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single();
      
      if (!userLabError && userLab?.lab_id) {
        console.warn('Using lab_id from user_labs table (consider updating users table):', userLab.lab_id);
        return userLab.lab_id;
      }
    } catch (err) {
      // user_labs table might not exist, which is fine
    }
    
    // Final fallback: For development/demo purposes, get first available lab
    try {
      const { data: labs, error: labError } = await supabase
        .from('labs')
        .select('id')
        .eq('is_active', true)
        .limit(1);
      
      if (!labError && labs && labs.length > 0) {
        console.warn('Lab ID not found for user. Using first available lab for demo:', labs[0].id);
        console.warn('Please update the users table with proper lab_id for user:', user.email);
        return labs[0].id;
      }
    } catch (err) {
      console.warn('Could not fetch default lab:', err);
    }
    
    console.error('No lab_id found for user and no default lab available');
    return null;
  },


  patients: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('is_active', true)
        .eq('lab_id', lab_id)
        .order('created_at', { ascending: false });
      return { data, error };
    },

    getAllWithTestCounts: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      const { data, error } = await supabase
        .from('patients')
        .select(`
          *,
          orders!inner(count)
        `)
        .eq('is_active', true)
        .eq('lab_id', lab_id)
        .order('created_at', { ascending: false });
      // Optionally, transform data here if needed
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('id', id)
        .single();
      return { data, error };
    },

    create: async (patientData: any) => {
      const { requestedTests, referring_doctor, ...patientDetails } = patientData;
      
      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      // Get today's date in DD-Mon-YYYY format
      const today = new Date();
      const day = today.getDate().toString().padStart(2, '0');
      const month = today.toLocaleString('en-US', { month: 'short' });
      const year = today.getFullYear();
      const dateFormatted = `${day}-${month}-${year}`;
      
      // Count patients registered today to determine sequential number
      const { count: todayCount, error: countError } = await supabase
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .eq('lab_id', lab_id)
        .gte('created_at', today.toISOString().split('T')[0]);
      
      if (countError) {
        console.error('Error counting today\'s patients:', countError);
        return { data: null, error: countError };
      }
      
      // Calculate sequential number (1-indexed)
      const sequentialNumber = (todayCount || 0) + 1;
      
      // Generate display_id in format DD-Mon-YYYY-SeqNum
      const display_id = `${dateFormatted}-${sequentialNumber}`;
      
      // Create patient with display_id and lab_id
      const { data, error } = await supabase
        .from('patients')
        .insert([{
          ...patientDetails,
          referring_doctor,
          display_id,
          lab_id
        }])
        .select()
        .single();
      
      if (error || !data) {
        return { data, error };
      }

      // Patient created successfully - QR codes and colors are now handled in orders
      // Step 3: Create order if tests were requested
      if (requestedTests && requestedTests.length > 0) {
        try {
          // Get test groups from database to match test names
          const { data: testGroups, error: testGroupsError } = await supabase
            .from('test_groups')
            .select('*');
          
          if (testGroupsError) {
            console.error('Error fetching test groups:', testGroupsError);
          } else {
            // Match requested tests to test groups
            const matchedTests: string[] = [];
            let totalAmount = 0;
            
            requestedTests.forEach((testName: string) => {
              const matchedGroup = testGroups?.find(group => 
                group.name.toLowerCase().includes(testName.toLowerCase()) ||
                testName.toLowerCase().includes(group.name.toLowerCase())
              );
              
              if (matchedGroup) {
                matchedTests.push(matchedGroup.name);
                totalAmount += matchedGroup.price;
              } else {
                // Add unmatched tests as-is for manual review
                matchedTests.push(testName);
                totalAmount += 500; // Default price for unmatched tests
              }
            });
            
            if (matchedTests.length > 0) {
              // Create order for the new patient
              const orderData = {
                patient_name: data.name,
                patient_id: data.id,
                tests: matchedTests,
                status: 'Sample Collection',
                priority: 'Normal',
                order_date: new Date().toISOString().split('T')[0],
                expected_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 2 days from now
                total_amount: totalAmount,
                doctor: referring_doctor || 'Self',
              };
              
              const { data: orderResult, error: orderError } = await database.orders.create(orderData);
              
              if (orderError) {
                console.error('Error creating order:', orderError);
                // Don't fail patient creation if order creation fails
              } else {
                console.log('Order created successfully:', orderResult?.id);
                // Add order info to the response
                return { 
                  data: { 
                    ...data, 
                    order_created: true, 
                    order_id: orderResult?.id,
                    matched_tests: matchedTests.length,
                    total_tests: requestedTests.length
                  }, 
                  error: null 
                };
              }
            }
          }
        } catch (orderCreationError) {
          console.error('Error in order creation process:', orderCreationError);
          // Don't fail patient creation if order creation fails
        }
      }
      
      // Patient created successfully
      return { data: data, error: null };
    },

    update: async (id: string, patientData: any) => {
      const { data, error } = await supabase
        .from('patients')
        .update(patientData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from('patients')
        .update({ is_active: false })
        .eq('id', id);
      return { error };
    }
  },
  
  // Get today's patient count for color assignment
  getTodaysPatientsCount: async () => {
    const today = new Date().toISOString().split('T')[0];
    const { count, error } = await supabase
      .from('patients')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', today);
    
    return { count: count || 0, error };
  },
  
  reports: {
    getAll: async () => {
      const { data, error } = await supabase
        .from('reports')
        .select('id, patient_id, result_id, status, generated_date, doctor, notes, created_at, updated_at, patients(name), results(test_name)')
        .order('generated_date', { ascending: false });
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .eq('id', id)
        .single();
      return { data, error };
    },

    create: async (reportData: any) => {
      const { data, error } = await supabase
        .from('reports')
        .insert([reportData])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, reportData: any) => {
      const { data, error } = await supabase
        .from('reports')
        .update(reportData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from('reports')
        .delete()
        .eq('id', id);
      return { error };
    }
  },
  
  orders: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      const { data, error } = await supabase
        .from('orders')
        .select(`
          *,
          patients(name, age, gender),
          order_tests(test_name, created_at),
          results(id, status, result_values(parameter, value, unit, reference_range, flag))
        `)
        .eq('lab_id', lab_id)
        .order('order_date', { ascending: false });
      
      if (error || !data) return { data, error };
      
      // Sort order_tests by creation date (newest first) for each order
      data.forEach((order: any) => {
        if (order.order_tests && order.order_tests.length > 0) {
          order.order_tests.sort((a: any, b: any) => {
            const dateA = new Date(a.created_at || new Date());
            const dateB = new Date(b.created_at || new Date());
            return dateB.getTime() - dateA.getTime();
          });
        }
      });
      
      // Manually fetch attachments for each order
      const ordersWithAttachments = await Promise.all(
        data.map(async (order) => {
          const { data: orderAttachments } = await supabase
            .from('attachments')
            .select('id, file_url, original_filename, file_type')
            .eq('related_table', 'orders')
            .eq('related_id', order.id);
          
          return {
            ...order,
            attachments: orderAttachments || []
          };
        })
      );
      
      return { data: ordersWithAttachments, error: null };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('orders')
        .select(`
          *,
          order_tests(*, created_at)
        `)
        .eq('id', id)
        .single();
      
      // Sort order_tests by creation date (newest first) if data exists
      if (data && data.order_tests) {
        data.order_tests.sort((a: any, b: any) => {
          const dateA = new Date(a.created_at || a.created_at);
          const dateB = new Date(b.created_at || b.created_at);
          return dateB.getTime() - dateA.getTime();
        });
      }
      
      return { data, error };
    },

    create: async (orderData: any) => {
      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      // First get the daily sequence for sample ID generation
      const orderDate = orderData.order_date || new Date().toISOString().split('T')[0];
      
      // Count existing orders for this date to get sequence number (filtered by lab_id)
      const { count: dailyOrderCount, error: countError } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('lab_id', lab_id)
        .gte('order_date', orderDate)
        .lt('order_date', new Date(new Date(orderDate).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
      
      if (countError) {
        console.error('Error counting daily orders:', countError);
        return { data: null, error: countError };
      }
      
      const dailySequence = (dailyOrderCount || 0) + 1;
      
      // Generate sample tracking data for this order
      const sampleId = generateOrderSampleId(new Date(orderDate), dailySequence);
      const { color_code, color_name } = getOrderAssignedColor(dailySequence);
      
      // Create the order with sample tracking data and lab_id
      const { tests, ...orderDetails } = orderData;
      const orderWithSample = {
        ...orderDetails,
        sample_id: sampleId,
        color_code,
        color_name,
        lab_id,
        status: orderData.status || 'Order Created' // Default status
      };
      
      const { data: order, error } = await supabase
        .from('orders')
        .insert([orderWithSample])
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      // Generate QR code data with the created order ID
      const qrCodeData = generateOrderQRCodeData({
        id: order.id,
        patientId: order.patient_id,
        sampleId: order.sample_id,
        orderDate: order.order_date,
        colorCode: order.color_code,
        colorName: order.color_name,
        patientName: order.patient_name
      });

      // Update order with QR code data
      const { data: updatedOrder, error: updateError } = await supabase
        .from('orders')
        .update({ qr_code_data: qrCodeData })
        .eq('id', order.id)
        .select()
        .single();

      if (updateError) {
        console.error('Error updating order with QR code:', updateError);
        return { data: order, error: updateError };
      }

      // Then create the associated tests only if there are tests to create
      if (updatedOrder && tests && Array.isArray(tests) && tests.length > 0) {
        let orderTestsData: any[] = [];
        
        // Handle both string array (legacy) and object array (new format)
        if (typeof tests[0] === 'string') {
          // Legacy format - lookup test_group_ids from test_groups table
          const validTestNames = tests.filter(test => test && typeof test === 'string' && test.trim() !== '');
          
          if (validTestNames.length > 0) {
            const { data: testGroups, error: testGroupError } = await supabase
              .from('test_groups')
              .select('id, name')
              .in('name', validTestNames);
            
            if (testGroupError) {
              console.error('Error fetching test groups:', testGroupError);
            }
            
            // Create a map of test name to test_group_id
            const testGroupMap = new Map<string, string>();
            (testGroups || []).forEach(tg => {
              testGroupMap.set(tg.name, tg.id);
            });
            
            orderTestsData = validTestNames.map(testName => ({
              order_id: updatedOrder.id,
              test_name: testName,
              test_group_id: testGroupMap.get(testName) || null,
              sample_id: updatedOrder.sample_id,
              lab_id
            }));
          }
        } else {
          // New format - tests are objects with id and name
          const validTestObjects = tests.filter(test => 
            test && 
            typeof test === 'object' && 
            test.name && 
            test.name.trim() !== ''
          );
          
          orderTestsData = validTestObjects.map(test => ({
            order_id: updatedOrder.id,
            test_name: test.name,
            test_group_id: test.type === 'test' ? test.id : null, // Only include test_group_id for individual tests, not packages
            sample_id: updatedOrder.sample_id,
            lab_id
          }));
        }
        
        if (orderTestsData.length > 0) {
          console.log('Creating order_tests with test_group_ids:', orderTestsData);
          
          const { error: orderTestsError } = await supabase
            .from('order_tests')
            .insert(orderTestsData);
          
          if (orderTestsError) {
            console.error('Error creating order tests:', orderTestsError);
            return { data: updatedOrder, error: orderTestsError };
          }
          
          console.log(`✅ Created ${orderTestsData.length} order test records with proper test_group_ids`);
        }
      }

      return { data: { ...updatedOrder, tests: tests || [] }, error: null };
    },

    update: async (id: string, orderData: any) => {
      const { data, error } = await supabase
        .from('orders')
        .update(orderData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from('orders')
        .delete()
        .eq('id', id);
      return { error };
    },

    // Auto-update order status based on results
    checkAndUpdateStatus: async (orderId: string) => {
      try {
        // Get order with tests and results
        const { data: order, error: orderError } = await supabase
          .from('orders')
          .select(`
            *,
            order_tests(test_name),
            results(id, status, result_values(id))
          `)
          .eq('id', orderId)
          .single();

        if (orderError || !order) {
          console.error('Error fetching order for status check:', orderError);
          return { data: null, error: orderError };
        }

        const totalTests = order.order_tests?.length || 0;
        const results = order.results || [];
        
        // Count results by status
        const resultsWithValues = results.filter((r: any) => r.result_values && r.result_values.length > 0);
        const approvedResults = results.filter((r: any) => r.status === 'Approved');
        
        let newStatus = order.status;
        
        // Determine new status based on completion
        if (order.status === 'In Progress') {
          // If all tests have results submitted, move to Pending Approval
          if (resultsWithValues.length >= totalTests && totalTests > 0) {
            newStatus = 'Pending Approval';
          }
        } else if (order.status === 'Pending Approval') {
          // If all results are approved, move to Completed
          if (approvedResults.length >= totalTests && totalTests > 0) {
            newStatus = 'Completed';
          }
        }

        // Update status if it changed
        if (newStatus !== order.status) {
          const { data: updatedOrder, error: updateError } = await supabase
            .from('orders')
            .update({ 
              status: newStatus,
              status_updated_at: new Date().toISOString(),
              status_updated_by: 'System (Auto)'
            })
            .eq('id', orderId)
            .select()
            .single();

          if (updateError) {
            console.error('Error updating order status:', updateError);
            return { data: null, error: updateError };
          }

          console.log(`Order ${orderId} status automatically updated from "${order.status}" to "${newStatus}"`);
          return { data: { ...updatedOrder, statusChanged: true, previousStatus: order.status }, error: null };
        }

        return { data: { ...order, statusChanged: false }, error: null };
      } catch (error) {
        console.error('Error in checkAndUpdateStatus:', error);
        return { data: null, error };
      }
    },

    // Mark order as delivered (manual trigger)
    markAsDelivered: async (orderId: string, deliveredBy?: string) => {
      try {
        const { data: updatedOrder, error } = await supabase
          .from('orders')
          .update({ 
            status: 'Delivered',
            delivered_at: new Date().toISOString(),
            delivered_by: deliveredBy || 'System',
            status_updated_at: new Date().toISOString(),
            status_updated_by: deliveredBy || 'System'
          })
          .eq('id', orderId)
          .select()
          .single();

        if (error) {
          console.error('Error marking order as delivered:', error);
          return { data: null, error };
        }

        console.log(`Order ${orderId} marked as delivered`);
        return { data: updatedOrder, error: null };
      } catch (error) {
        console.error('Error in markAsDelivered:', error);
        return { data: null, error };
      }
    }
  },
  
  results: {
    getAll: async () => {
      const { data, error } = await supabase
        .from('results')
        .select(`
          *, 
          result_values(*), 
          attachment_id, 
          extracted_by_ai, 
          ai_confidence, 
          manually_verified, 
          ai_extraction_metadata
        `) // Include AI and attachment columns
        .order('entered_date', { ascending: false });
      
      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id, 
      // check for attachments linked to its order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id && result.order_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from('attachments')
              .select('id, file_url, description, original_filename')
              .eq('related_table', 'orders')
              .eq('related_id', result.order_id)
              .order('created_at', { ascending: false })
              .limit(1);
            
            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0]
              };
            }
          }
          return result;
        })
      );

      return { data: enrichedData, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('results')
        .select('*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata')
        .eq('id', id)
        .single();
      
      if (error || !data) {
        return { data, error };
      }

      // If no direct attachment_id, check for attachments linked to the order
      if (!data.attachment_id && data.order_id) {
        const { data: orderAttachments } = await supabase
          .from('attachments')
          .select('id, file_url, description, original_filename')
          .eq('related_table', 'orders')
          .eq('related_id', data.order_id)
          .order('created_at', { ascending: false })
          .limit(1);
        
        if (orderAttachments && orderAttachments.length > 0) {
          return {
            data: {
              ...data,
              attachment_id: orderAttachments[0].id,
              attachment_info: orderAttachments[0]
            },
            error: null
          };
        }
      }

      return { data, error };
    },

    getByOrderId: async (orderId: string) => {
      const { data, error } = await supabase
        .from('results')
        .select('*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata')
        .eq('order_id', orderId)
        .order('entered_date', { ascending: false });
      
      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id, 
      // check for attachments linked to this order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from('attachments')
              .select('id, file_url, description, original_filename')
              .eq('related_table', 'orders')
              .eq('related_id', orderId)
              .order('created_at', { ascending: false })
              .limit(1);
            
            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0]
              };
            }
          }
          return result;
        })
      );

      return { data: enrichedData, error };
    },
    create: async (resultData: any) => {
      const { values, ...rest } = resultData; // Separate values array
      const { data: result, error } = await supabase
        .from('results')
        .insert([rest]) // This will now include attachment_id and AI fields if provided
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      if (result && values && values.length > 0) {
        // First, get all analytes to map parameter names to analyte_ids
        const { data: analytes, error: analytesError } = await supabase
          .from('analytes')
          .select('id, name');
        
        if (analytesError) {
          console.error('Error fetching analytes:', analytesError);
          return { data: null, error: analytesError };
        }

        // Create a map of analyte names to IDs
        const analyteMap = new Map(analytes?.map(a => [a.name, a.id]) || []);

        const resultValuesToInsert = values.map((val: any) => ({
          result_id: result.id,
          order_id: result.order_id, // Add order_id for trigger compatibility
          analyte_id: analyteMap.get(val.parameter) || null, // Map parameter name to analyte_id
          parameter: val.parameter, // Keep parameter name as well
          value: val.value,
          unit: val.unit,
          reference_range: val.reference_range,
          flag: val.flag,
        }));
        
        const { error: valuesError } = await supabase
          .from('result_values')
          .insert(resultValuesToInsert);

        if (valuesError) {
          // Optionally, handle rollback of the result if result_values insertion fails
          console.error('Error inserting result values:', valuesError);
          return { data: null, error: valuesError };
        }
      }

      // Auto-update order status after result creation
      if (result.order_id) {
        await database.orders.checkAndUpdateStatus(result.order_id);
      }

      return { data: result, error: null };
    },

    update: async (id: string, resultData: any) => {
      const { values, ...rest } = resultData; // Separate values array from main result data
      
      // First update the main result record
      const { data: result, error } = await supabase
        .from('results')
        .update(rest)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      // If values are provided, update the result_values table
      if (result && values && values.length > 0) {
        // First delete existing result_values for this result
        const { error: deleteError } = await supabase
          .from('result_values')
          .delete()
          .eq('result_id', id);

        if (deleteError) {
          console.error('Error deleting existing result values:', deleteError);
          return { data: null, error: deleteError };
        }

        // Then insert the new result_values
        // First, get all analytes to map parameter names to analyte_ids
        const { data: analytes, error: analytesError } = await supabase
          .from('analytes')
          .select('id, name');
        
        if (analytesError) {
          console.error('Error fetching analytes:', analytesError);
          return { data: null, error: analytesError };
        }

        // Create a map of analyte names to IDs
        const analyteMap = new Map(analytes?.map(a => [a.name, a.id]) || []);

        const resultValuesToInsert = values.map((val: any) => ({
          result_id: id,
          order_id: result.order_id, // Add order_id for trigger compatibility
          analyte_id: analyteMap.get(val.parameter) || null, // Map parameter name to analyte_id
          parameter: val.parameter, // Keep parameter name as well
          value: val.value,
          unit: val.unit,
          reference_range: val.reference_range,
          flag: val.flag,
        }));
        
        const { error: valuesError } = await supabase
          .from('result_values')
          .insert(resultValuesToInsert);

        if (valuesError) {
          console.error('Error inserting updated result values:', valuesError);
          return { data: null, error: valuesError };
        }
      }

      // Auto-update order status after result update (especially for approval)
      if (result.order_id) {
        await database.orders.checkAndUpdateStatus(result.order_id);
      }
      
      return { data: result, error: null };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from('results')
        .delete()
        .eq('id', id);
      return { error };
    },

    getByPatientId: async (patientId: string) => {
      const { data, error } = await supabase
        .from('results')
        .select('*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata')
        .eq('patient_id', patientId)
        .order('entered_date', { ascending: false });
      
      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id, 
      // check for attachments linked to its order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id && result.order_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from('attachments')
              .select('id, file_url, description, original_filename')
              .eq('related_table', 'orders')
              .eq('related_id', result.order_id)
              .order('created_at', { ascending: false })
              .limit(1);
            
            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0]
              };
            }
          }
          return result;
        })
      );

      return { data: enrichedData, error };
    },

    // New function to get results by attachment ID
    getByAttachmentId: async (attachmentId: string) => {
      const { data, error } = await supabase
        .from('results')
        .select('*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata')
        .eq('attachment_id', attachmentId)
        .order('entered_date', { ascending: false });
      return { data, error };
    }
  },

  result_values: {
    // Direct CRUD operations for result_values are typically not needed if managed via results
  },

  invoices: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      // Query invoices with basic data
      const { data, error } = await supabase
        .from('invoices')
        .select(`
          *,
          invoice_items(*)
        `)
        .eq('lab_id', lab_id)
        .order('invoice_date', { ascending: false });
      
      if (error) {
        return { data: null, error };
      }
      
      // Add paid_amount = 0 to all invoices (will be calculated by payments functionality later)
      const invoicesWithPayments = (data || []).map(invoice => ({
        ...invoice,
        paid_amount: 0,
        payment_status: invoice.status
      }));
      
      return { data: invoicesWithPayments, error: null };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('invoices')
        .select(`
          *,
          invoice_items(*)
        `)
        .eq('id', id)
        .single();
      return { data, error };
    },

    create: async (invoiceData: any) => {
      const { invoice_items, ...invoiceDetails } = invoiceData;
      
      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: new Error('No lab_id found for current user') };
      }
      
      // First create the invoice with lab_id
      const { data: invoice, error } = await supabase
        .from('invoices')
        .insert([{ ...invoiceDetails, lab_id }])
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      // Then create the associated invoice items
      if (invoice && invoice_items && invoice_items.length > 0) {
        const invoiceItemsToInsert = invoice_items.map((item: any) => ({
          ...item,
          invoice_id: invoice.id,
          lab_id
        }));

        const { error: itemsError } = await supabase
          .from('invoice_items')
          .insert(invoiceItemsToInsert);

        if (itemsError) {
          console.error('Error inserting invoice items:', itemsError);
          return { data: invoice, error: itemsError };
        }
      }

      return { data: { ...invoice, invoice_items }, error: null };
    },

    update: async (id: string, invoiceData: any) => {
      const { data, error } = await supabase
        .from('invoices')
        .update(invoiceData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from('invoices')
        .delete()
        .eq('id', id);
      return { error };
    }
  },
  
  invoice_items: {
    create: async (items: any[]) => {
      const { data, error } = await supabase
        .from('invoice_items')
        .insert(items)
        .select();
      return { data, error };
    },
    
    update: async (id: string, itemData: any) => {
      const { data, error } = await supabase
        .from('invoice_items')
        .update(itemData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },
    
    delete: async (id: string) => {
      const { error } = await supabase
        .from('invoice_items')
        .delete()
        .eq('id', id);
      return { error };
    }
  },
  
  payments: {
    getByInvoiceId: async (invoiceId: string) => {
      const { data, error } = await supabase
        .from('payments')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('payment_date', { ascending: false });
      return { data, error };
    },
    
    create: async (paymentData: any) => {
      // Get current user's lab_id if not already provided
      if (!paymentData.lab_id) {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          return { data: null, error: new Error('No lab_id found for current user') };
        }
        paymentData.lab_id = lab_id;
      }
      
      const { data, error } = await supabase
        .from('payments')
        .insert([paymentData])
        .select()
        .single();
      return { data, error };
    },
    
    getPaymentSummary: async (startDate?: string, endDate?: string, method?: string) => {
      let query = supabase
        .from('payments')
        .select('*');
      
      if (startDate) {
        query = query.gte('payment_date', startDate);
      }
      
      if (endDate) {
        query = query.lte('payment_date', endDate);
      }
      
      if (method) {
        query = query.eq('payment_method', method);
      }
      
      const { data, error } = await query.order('payment_date', { ascending: false });
      return { data, error };
    }
  },

  analytes: {
    getAll: async () => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        console.warn('No lab ID found for current user, fetching all active analytes globally. This might not be the intended behavior for a multi-lab setup.');
        const { data, error } = await supabase
          .from('analytes')
          .select('*')
          .eq('is_active', true)
          .order('name');
        return { data, error };
      }

      // Fetch analytes joined with lab_analytes for the specific lab
      const { data, error } = await supabase
        .from('lab_analytes')
        .select(`
          is_active,
          visible,
          lab_specific_reference_range,
          lab_specific_interpretation_low,
          lab_specific_interpretation_normal,
          lab_specific_interpretation_high,
          analytes(*)
        `)
        .eq('lab_id', labId)
        .eq('is_active', true)
        .eq('visible', true);
      
      if (error) {
        return { data: null, error };
      }
      
      // Flatten the structure to match the expected Analyte interface
      const formattedData = Array.isArray(data)
        ? data.map(item => {
            // item.analytes may be an array or object, handle accordingly
            const analyteObj = Array.isArray(item.analytes) ? item.analytes[0] : item.analytes;
            if (analyteObj) {
              return {
                ...analyteObj,
                is_active: item.is_active,
                visible: item.visible,
                // Prioritize lab-specific values if they exist, otherwise use global
                referenceRange: item.lab_specific_reference_range || analyteObj.reference_range,
                interpretation: {
                  low: item.lab_specific_interpretation_low || analyteObj.interpretation_low,
                  normal: item.lab_specific_interpretation_normal || analyteObj.interpretation_normal,
                  high: item.lab_specific_interpretation_high || analyteObj.interpretation_high,
                },
              };
            }
            return null;
          }).filter(Boolean)
        : [];
      return { data: formattedData, error: null };
    },

    // Get global analytes (for master analyte management)
    getAllGlobal: async () => {
      const { data, error } = await supabase
        .from('analytes')
        .select('*')
        .eq('is_global', true)
        .eq('is_active', true)
        .order('name');
      return { data, error };
    },

    // Create a new analyte
    create: async (analyteData: {
      name: string;
      unit: string;
      reference_range: string;
      low_critical?: string;
      high_critical?: string;
      interpretation_low?: string;
      interpretation_normal?: string;
      interpretation_high?: string;
      category?: string;
      is_global?: boolean;
      is_active?: boolean;
      ai_processing_type?: string;
      ai_prompt_override?: string;
    }) => {
      const { data, error } = await supabase
        .from('analytes')
        .insert([{
          name: analyteData.name,
          unit: analyteData.unit,
          reference_range: analyteData.reference_range,
          low_critical: analyteData.low_critical,
          high_critical: analyteData.high_critical,
          interpretation_low: analyteData.interpretation_low,
          interpretation_normal: analyteData.interpretation_normal,
          interpretation_high: analyteData.interpretation_high,
          category: analyteData.category || 'General', // Ensure category is never null
          is_global: analyteData.is_global || false,
          is_active: analyteData.is_active !== false, // Default to true
          ai_processing_type: analyteData.ai_processing_type,
          ai_prompt_override: analyteData.ai_prompt_override
        }])
        .select()
        .single();
      return { data, error };
    },

    // Update analyte global status
    updateGlobalStatus: async (analyteId: string, isGlobal: boolean) => {
      const { data, error } = await supabase
        .from('analytes')
        .update({ is_global: isGlobal })
        .eq('id', analyteId)
        .select()
        .single();
      return { data, error };
    },

    // Update analyte
    update: async (analyteId: string, updates: {
      name?: string;
      unit?: string;
      reference_range?: string;
      low_critical?: string;
      high_critical?: string;
      interpretation_low?: string;
      interpretation_normal?: string;
      interpretation_high?: string;
      category?: string;
      is_active?: boolean;
      ai_processing_type?: string;
      ai_prompt_override?: string;
    }) => {
      const { data, error } = await supabase
        .from('analytes')
        .update({
          name: updates.name,
          unit: updates.unit,
          reference_range: updates.reference_range,
          low_critical: updates.low_critical,
          high_critical: updates.high_critical,
          interpretation_low: updates.interpretation_low,
          interpretation_normal: updates.interpretation_normal,
          interpretation_high: updates.interpretation_high,
          category: updates.category,
          is_active: updates.is_active,
          ai_processing_type: updates.ai_processing_type,
          ai_prompt_override: updates.ai_prompt_override,
          updated_at: new Date().toISOString()
        })
        .eq('id', analyteId)
        .select()
        .single();
      return { data, error };
    },
  },

  // Workflow dynamic engine helpers (lab scoped)
  workflows: {
    getLabWorkflowForTest: async (labId: string, testCode: string) => {
      try {
        // Find mapping
        const { data: mapping, error: mapError } = await supabase
          .from('test_workflow_map')
          .select('id, workflow_version_id')
          .eq('lab_id', labId)
          .eq('test_code', testCode)
          .eq('is_default', true)
          .maybeSingle();
        if (mapError || !mapping) return { data: null, error: mapError };
        const { data: version, error: verError } = await supabase
          .from('workflow_versions')
          .select('id, version, definition, workflow_id')
          .eq('id', mapping.workflow_version_id)
          .single();
        if (verError) return { data: null, error: verError };
        return { data: version, error: null };
      } catch (e: any) {
        return { data: null, error: e };
      }
    },
    getOrderWorkflowInstance: async (orderId: string) => {
      const { data, error } = await supabase
        .from('order_workflow_instances')
        .select('id, workflow_version_id, current_step_id, started_at, completed_at')
        .eq('order_id', orderId)
        .maybeSingle();
      return { data, error };
    },
    createOrderWorkflowInstance: async (orderId: string, workflowVersionId: string, firstStepId: string) => {
      const { data, error } = await supabase
        .from('order_workflow_instances')
        .insert({ order_id: orderId, workflow_version_id: workflowVersionId, current_step_id: firstStepId })
        .select()
        .single();
      return { data, error };
    },
    updateOrderWorkflowCurrentStep: async (instanceId: string, nextStepId: string | null) => {
      const patch: any = { current_step_id: nextStepId };
      if (!nextStepId) patch.completed_at = new Date().toISOString();
      const { data, error } = await supabase
        .from('order_workflow_instances')
        .update(patch)
        .eq('id', instanceId)
        .select()
        .single();
      return { data, error };
    },
    insertStepEvent: async (instanceId: string, stepId: string, eventType: string, payload?: any) => {
      const { data, error } = await supabase
        .from('workflow_step_events')
        .insert({ instance_id: instanceId, step_id: stepId, event_type: eventType, payload })
        .select()
        .single();
      return { data, error };
    }
  },

  // Lab-specific analyte management
  labAnalytes: {
    // Get lab-specific analyte configuration
    getByLabAndAnalyte: async (labId: string, analyteId: string) => {
      const { data, error } = await supabase
        .from('lab_analytes')
        .select(`
          *,
          analytes(*)
        `)
        .eq('lab_id', labId)
        .eq('analyte_id', analyteId)
        .single();
      return { data, error };
    },

    // Update lab-specific analyte settings
    updateLabSpecific: async (labId: string, analyteId: string, updates: {
      is_active?: boolean;
      visible?: boolean;
      lab_specific_reference_range?: string;
      lab_specific_interpretation_low?: string;
      lab_specific_interpretation_normal?: string;
      lab_specific_interpretation_high?: string;
    }) => {
      const { data, error } = await supabase
        .from('lab_analytes')
        .update(updates)
        .eq('lab_id', labId)
        .eq('analyte_id', analyteId)
        .select()
        .single();
      return { data, error };
    },

    // Add global analytes to a specific lab
    addGlobalAnalytesToLab: async (labId: string) => {
      const { data, error } = await supabase.rpc('add_global_analytes_to_lab', {
        target_lab_id: labId
      });
      return { data, error };
    },

    // Get all lab analytes for a specific lab (including inactive/invisible ones)
    getAllForLab: async (labId: string) => {
      const { data, error } = await supabase
        .from('lab_analytes')
        .select(`
          *,
          analytes(*)
        `)
        .eq('lab_id', labId)
        .order('analytes(name)');
      return { data, error };
    },

    // Sync global analytes to all labs
    syncGlobalAnalytesToAllLabs: async () => {
      const { data, error } = await supabase.rpc('sync_global_analytes_to_all_labs');
      return { data, error };
    },

    // Get analyte usage statistics
    getUsageStats: async () => {
      const { data, error } = await supabase.rpc('get_analyte_lab_usage_stats');
      return { data, error };
    },
    // ...existing code...
  },

  testGroups: {
    getAll: async () => {
      const { data, error } = await supabase
        .from('test_groups')
        .select(`
          id,
          name,
          code,
          category,
          clinical_purpose,
          price,
          turnaround_time,
          sample_type,
          requires_fasting,
          is_active,
          created_at,
          updated_at,
          default_ai_processing_type,
          group_level_prompt,
          lab_id,
          to_be_copied,
          test_group_analytes(
            analyte_id,
            analytes(
              id,
              name,
              unit,
              reference_range,
              ai_processing_type,
              ai_prompt_override,
              group_ai_mode
            )
          )
        `)
        .eq('is_active', true)
        .order('name');
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('test_groups')
        .select(`
          id,
          name,
          code,
          category,
          clinical_purpose,
          price,
          turnaround_time,
          sample_type,
          requires_fasting,
          is_active,
          created_at,
          updated_at,
          default_ai_processing_type,
          group_level_prompt,
          lab_id,
          to_be_copied,
          test_group_analytes(
            analyte_id,
            analytes(
              id,
              name,
              unit,
              reference_range,
              ai_processing_type,
              ai_prompt_override,
              group_ai_mode
            )
          )
        `)
        .eq('id', id)
        .single();
      return { data, error };
    },

    getByNames: async (names: string[]) => {
      const { data, error } = await supabase
        .from('test_groups')
        .select(`
          id,
          name,
          code,
          category,
          clinical_purpose,
          price,
          turnaround_time,
          sample_type,
          requires_fasting,
          is_active,
          created_at,
          updated_at,
          default_ai_processing_type,
          group_level_prompt,
          lab_id,
          to_be_copied,
          test_group_analytes(
            analyte_id,
            analytes(
              id,
              name,
              unit,
              reference_range,
              ai_processing_type,
              ai_prompt_override,
              group_ai_mode
            )
          )
        `)
        .in('name', names)
        .eq('is_active', true);
      return { data, error };
    },

    create: async (testGroupData: any) => {
      try {
        // Ensure all required fields have valid values
        const sanitizedData = {
          name: testGroupData.name || 'Unnamed Test Group',
          code: testGroupData.code || 'UNNAMED',
          category: testGroupData.category || 'Laboratory',
          clinical_purpose: testGroupData.clinicalPurpose || 'Clinical assessment and diagnosis',
          price: testGroupData.price || 0,
          turnaround_time: testGroupData.turnaroundTime || '24 hours',
          sample_type: testGroupData.sampleType || 'Serum',
          requires_fasting: testGroupData.requiresFasting || false,
          is_active: testGroupData.isActive !== false,
          default_ai_processing_type: testGroupData.default_ai_processing_type || 'ocr_report',
          group_level_prompt: testGroupData.group_level_prompt || null,
          lab_id: testGroupData.lab_id || null,
          to_be_copied: testGroupData.to_be_copied || false
        };

        console.log('Creating test group with data:', sanitizedData);

        // Step 1: Create the test group
        const { data: testGroup, error: testGroupError } = await supabase
          .from('test_groups')
          .insert([sanitizedData])
          .select()
          .single();

        if (testGroupError) {
          console.error('Error creating test group:', testGroupError);
          return { data: null, error: testGroupError };
        }

        // Step 2: Create test group analyte relationships
        if (testGroupData.analytes && testGroupData.analytes.length > 0) {
          const analyteRelations = testGroupData.analytes.map((analyteId: string) => ({
            test_group_id: testGroup.id,
            analyte_id: analyteId
          }));

          const { error: relationError } = await supabase
            .from('test_group_analytes')
            .insert(analyteRelations);

          if (relationError) {
            console.error('Error creating test group analyte relations:', relationError);
            // Still return the test group even if analyte relations failed
            return { data: testGroup, error: relationError };
          }
        }

        return { data: testGroup, error: null };
      } catch (error) {
        console.error('Unexpected error creating test group:', error);
        return { data: null, error };
      }
    },

    update: async (id: string, updates: any) => {
      try {
        // Step 1: Update the test group
        const { data, error } = await supabase
          .from('test_groups')
          .update({
            name: updates.name,
            code: updates.code,
            category: updates.category,
            clinical_purpose: updates.clinicalPurpose,
            price: updates.price,
            turnaround_time: updates.turnaroundTime,
            sample_type: updates.sampleType,
            requires_fasting: updates.requiresFasting,
            is_active: updates.isActive,
            default_ai_processing_type: updates.default_ai_processing_type,
            group_level_prompt: updates.group_level_prompt,
            updated_at: new Date().toISOString()
          })
          .eq('id', id)
          .select()
          .single();
        
        if (error) {
          console.error('Error updating test group:', error);
          return { data: null, error };
        }

        // Step 2: Update analyte relationships if analytes are provided
        if (updates.analytes && Array.isArray(updates.analytes)) {
          // First delete existing analyte relationships
          const { error: deleteError } = await supabase
            .from('test_group_analytes')
            .delete()
            .eq('test_group_id', id);

          if (deleteError) {
            console.error('Error deleting existing analyte relationships:', deleteError);
            return { data, error: deleteError };
          }

          // Then insert new analyte relationships
          if (updates.analytes.length > 0) {
            const analyteRelations = updates.analytes.map((analyteId: string) => ({
              test_group_id: id,
              analyte_id: analyteId
            }));

            const { error: insertError } = await supabase
              .from('test_group_analytes')
              .insert(analyteRelations);

            if (insertError) {
              console.error('Error inserting new analyte relationships:', insertError);
              return { data, error: insertError };
            }
          }
        }
        
        return { data, error: null };
      } catch (error) {
        console.error('Unexpected error updating test group:', error);
        return { data: null, error };
      }
    },

    delete: async (id: string) => {
      // First delete analyte relationships
      await supabase
        .from('test_group_analytes')
        .delete()
        .eq('test_group_id', id);

      // Then delete the test group
      const { error } = await supabase
        .from('test_groups')
        .delete()
        .eq('id', id);
      
      return { error };
    }
  },

  packages: {
    getAll: async () => {
      const { data, error } = await supabase
        .from('packages')
        .select(`
          id,
          name,
          description,
          price,
          is_active,
          created_at,
          updated_at,
          lab_id,
          package_test_groups(
            test_group_id,
            test_groups(
              id,
              name,
              code,
              category,
              price
            )
          )
        `)
        .eq('is_active', true)
        .order('name');
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from('packages')
        .select(`
          id,
          name,
          description,
          price,
          is_active,
          created_at,
          updated_at,
          lab_id,
          package_test_groups(
            test_group_id,
            test_groups(
              id,
              name,
              code,
              category,
              price,
              clinical_purpose,
              turnaround_time,
              sample_type,
              requires_fasting
            )
          )
        `)
        .eq('id', id)
        .single();
      return { data, error };
    },

    create: async (packageData: any) => {
      const { data, error } = await supabase
        .from('packages')
        .insert([packageData])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, packageData: any) => {
      const { data, error } = await supabase
        .from('packages')
        .update(packageData)
        .eq('id', id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      // First delete related package_test_groups
      await supabase
        .from('package_test_groups')
        .delete()
        .eq('package_id', id);

      // Then delete the package
      const { error } = await supabase
        .from('packages')
        .delete()
        .eq('id', id);
      
      return { error };
    }
  },

};

// Database helper functions for attachments
export const attachments = {
  // Upload file with metadata including test-level support
  upload: async (file: File, metadata: {
    patient_id?: string;
    related_table: string;
    related_id: string;
    order_id?: string;
    order_test_id?: string; // New field for test-level attachments
    description?: string;
    tag?: string;
  }) => {
    try {
      const labId = await database.getCurrentUserLabId();
      const timestamp = Date.now();
      const fileName = `${timestamp}_${file.name}`;
      const filePath = `attachments/${labId}/${fileName}`;

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from('attachments')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('attachments')
        .getPublicUrl(filePath);

      // Save attachment metadata
      const { data, error } = await supabase
        .from('attachments')
        .insert({
          patient_id: metadata.patient_id,
          related_table: metadata.related_table,
          related_id: metadata.related_id,
          order_id: metadata.order_id,
          order_test_id: metadata.order_test_id, // Save test association
          file_url: publicUrl,
          file_type: file.type,
          file_path: filePath,
          original_filename: file.name,
          stored_filename: fileName,
          file_size: file.size,
          description: metadata.description,
          tag: metadata.tag,
          lab_id: labId,
          uploaded_by: (await supabase.auth.getUser()).data.user?.id
        })
        .select()
        .single();

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error('Error uploading attachment:', error);
      return { data: null, error };
    }
  },

  // Get attachments by order test ID
  getByOrderTest: async (orderTestId: string) => {
    try {
      const { data, error } = await supabase
        .from('attachments')
        .select('*')
        .eq('order_test_id', orderTestId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error('Error fetching test attachments:', error);
      return { data: null, error };
    }
  },

  // Get attachments by order with test information
  getByOrderWithTestInfo: async (orderId: string) => {
    try {
      const { data, error } = await supabase
        .from('attachments')
        .select(`
          *,
          order_tests!attachments_order_test_id_fkey(
            id,
            test_name,
            test_group_id
          )
        `)
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error('Error fetching order attachments:', error);
      return { data: null, error };
    }
  },

  getByRelatedId: async (relatedTable: string, relatedId: string) => {
    const { data, error } = await supabase
      .from('attachments')
      .select('*')
      .eq('related_table', relatedTable)
      .eq('related_id', relatedId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  // Helper function specifically for orders (commonly used)
  getByOrderId: async (orderId: string) => {
    return attachments.getByRelatedId('orders', orderId);
  },

  // Helper function specifically for patients
  getByPatientIdRelated: async (patientId: string) => {
    return attachments.getByRelatedId('patients', patientId);
  },

  // Helper function specifically for results
  getByResultId: async (resultId: string) => {
    return attachments.getByRelatedId('results', resultId);
  },

  getByPatientId: async (patientId: string) => {
    const { data, error } = await supabase
      .from('attachments')
      .select('*')
      .eq('patient_id', patientId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  getByLabId: async (labId: string) => {
    const { data, error } = await supabase
      .from('attachments')
      .select('*')
      .eq('lab_id', labId)
      .order('created_at', { ascending: false });
    return { data, error };
  },
  getById: async (id: string) => {
    const { data, error } = await supabase
      .from('attachments')
      .select('*')
      .eq('id', id)
      .single();
    return { data, error };
  },

  create: async (attachmentData: any) => {
    const { data, error } = await supabase
      .from('attachments')
      .insert([attachmentData])
      .select()
      .single();
    return { data, error };
  },

  updateDescription: async (id: string, description: string) => {
    const { data, error } = await supabase
      .from('attachments')
      .update({ description })
      .eq('id', id)
      .select()
      .single();
    return { data, error };
  },
  delete: async (id: string) => {
    // First get the file path to delete from storage
    const { data: attachment, error: fetchError } = await supabase
      .from('attachments')
      .select('file_path')
      .eq('id', id)
      .single();
    
    if (fetchError) {
      return { error: fetchError };
    }
    
    // Delete from storage
    if (attachment?.file_path) {
      const { error: storageError } = await supabase.storage
        .from('attachments')
        .remove([attachment.file_path]);
      
      if (storageError) {
        console.warn('Failed to delete file from storage:', storageError);
      }
    }
    
    // Delete from database
    const { error } = await supabase
      .from('attachments')
      .delete()
      .eq('id', id);
    return { error };
  }
};

// Database helper functions for OCR results
export const ocrResults = {
  getByAttachmentId: async (attachmentId: string) => {
    const { data, error } = await supabase
      .from('ocr_results')
      .select('*')
      .eq('attachment_id', attachmentId)
      .order('created_at', { ascending: false });
    return { data, error };
  },

  create: async (ocrData: any) => {
    const { data, error } = await supabase
      .from('ocr_results')
      .insert([ocrData])
      .select()
      .single();
    return { data, error };
  }
};

// User management helper functions
export const userManagement = {
  // Get current user's profile from public.users
  getCurrentUserProfile: async () => {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { data: null, error: authError };
    }

    const { data, error } = await supabase
      .from('users')
      .select(`
        *,
        labs(id, name, code)
      `)
      .eq('email', user.email)
      .single();
    
    return { data, error };
  },

  // Update user's lab assignment
  updateUserLab: async (userId: string, labId: string) => {
    const { data, error } = await supabase
      .from('users')
      .update({ 
        lab_id: labId,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();
    
    return { data, error };
  },

  // Get all users for a specific lab
  getUsersByLab: async (labId: string) => {
    const { data, error } = await supabase
      .from('users')
      .select(`
        id,
        name,
        email,
        role,
        status,
        join_date,
        last_login
      `)
      .eq('lab_id', labId)
      .eq('status', 'Active')
      .order('name');
    
    return { data, error };
  },

  // Check if current user has admin access
  isCurrentUserAdmin: async () => {
    const { data: profile } = await userManagement.getCurrentUserProfile();
    return profile && ['Admin', 'Manager'].includes(profile.role);
  }
};