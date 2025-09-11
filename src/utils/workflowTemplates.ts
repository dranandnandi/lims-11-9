// Sample Survey.js workflow templates for different lab scenarios
export const SAMPLE_WORKFLOWS = {
  // Basic pipette validation workflow
  pipetteBasic: {
    ui: {
      engine: "surveyjs",
      template: {
        title: "Pipette Validation - Basic",
        description: "Basic pipette accuracy validation",
        showProgressBar: "top",
        pages: [{
          name: "pipette_check",
          title: "Pipette Accuracy Check",
          elements: [{
            type: "text",
            name: "pipette_id",
            title: "Scan Pipette QR Code",
            isRequired: true,
            inputType: "text",
            placeholder: "QR-P200-017"
          }, {
            type: "text",
            name: "target_volume",
            title: "Target Volume (μL)",
            isRequired: true,
            inputType: "number",
            defaultValue: "100"
          }, {
            type: "text",
            name: "actual_volume",
            title: "Actual Volume Dispensed (μL)",
            isRequired: true,
            inputType: "number"
          }, {
            type: "expression",
            name: "accuracy_check",
            title: "Accuracy Status",
            expression: "iif({actual_volume} >= {target_volume} * 0.95 and {actual_volume} <= {target_volume} * 1.05, '✅ Within Tolerance', '❌ Outside Tolerance')",
            displayStyle: "decimal"
          }]
        }],
        completedHtml: "<h3>Pipette validation completed!</h3><p>Results have been recorded.</p>"
      }
    },
    rules: {
      mode: "BASIC",
      triggerOn: "MANUAL",
      steps: [{
        no: 1,
        type: "pipette",
        required: true,
        target_volume_ul: 100,
        tolerance_pct: 5,
        allowed_pipettes: ["P200", "P1000"]
      }],
      validations: {
        pipettes: {
          "QR-P200-017": { model: "P200", min_ul: 20, max_ul: 200 },
          "QR-P1000-008": { model: "P1000", min_ul: 100, max_ul: 1000 }
        }
      }
    },
    meta: {
      title: "Basic Pipette Validation",
      description: "Simple pipette accuracy check with tolerance validation",
      owner: "Lab QA",
      version: "1.0.0",
      tags: ["pipette", "validation", "basic"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  },

  // Pro pipette workflow with multiple steps
  pipettePro: {
    ui: {
      engine: "surveyjs",
      template: {
        title: "Pipette Validation - Professional",
        description: "Comprehensive pipette validation with multiple volumes",
        showProgressBar: "top",
        pages: [{
          name: "setup",
          title: "Setup",
          elements: [{
            type: "text",
            name: "pipette_id",
            title: "Scan Pipette QR Code",
            isRequired: true
          }, {
            type: "text",
            name: "technician_id",
            title: "Technician ID",
            isRequired: true
          }, {
            type: "dropdown",
            name: "test_type",
            title: "Test Type",
            choices: ["Daily QC", "Weekly Calibration", "Annual Validation"],
            isRequired: true
          }]
        }, {
          name: "volume_1",
          title: "Volume Test 1 - Minimum",
          elements: [{
            type: "html",
            html: "<h4>Test minimum volume capacity</h4>"
          }, {
            type: "text",
            name: "vol1_target",
            title: "Target Volume (μL)",
            defaultValue: "20",
            readOnly: true
          }, {
            type: "text",
            name: "vol1_actual",
            title: "Actual Volume (μL)",
            isRequired: true,
            inputType: "number"
          }]
        }, {
          name: "volume_2",
          title: "Volume Test 2 - Maximum",
          elements: [{
            type: "html",
            html: "<h4>Test maximum volume capacity</h4>"
          }, {
            type: "text",
            name: "vol2_target",
            title: "Target Volume (μL)",
            defaultValue: "200",
            readOnly: true
          }, {
            type: "text",
            name: "vol2_actual",
            title: "Actual Volume (μL)",
            isRequired: true,
            inputType: "number"
          }]
        }, {
          name: "results",
          title: "Results Summary",
          elements: [{
            type: "expression",
            name: "overall_result",
            title: "Overall Result",
            expression: "iif({vol1_actual} >= 19 and {vol1_actual} <= 21 and {vol2_actual} >= 190 and {vol2_actual} <= 210, 'PASS', 'FAIL')"
          }, {
            type: "comment",
            name: "notes",
            title: "Additional Notes (Optional)"
          }]
        }]
      }
    },
    rules: {
      mode: "PRO",
      triggerOn: "MANUAL",
      steps: [
        { no: 1, type: "data_entry", required: true },
        { no: 2, type: "pipette", required: true, target_volume_ul: 20, tolerance_pct: 5 },
        { no: 3, type: "pipette", required: true, target_volume_ul: 200, tolerance_pct: 5 },
        { no: 4, type: "data_entry", required: false }
      ]
    },
    meta: {
      title: "Professional Pipette Validation",
      description: "Multi-step pipette validation with comprehensive testing",
      owner: "Lab QA",
      version: "1.0.0",
      tags: ["pipette", "validation", "professional", "multi-step"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  },

  // Sample collection workflow
  sampleCollection: {
    ui: {
      engine: "surveyjs",
      template: {
        title: "Sample Collection Workflow",
        description: "Standardized sample collection procedure",
        pages: [{
          name: "patient_info",
          title: "Patient Information",
          elements: [{
            type: "text",
            name: "patient_id",
            title: "Patient ID",
            isRequired: true
          }, {
            type: "text",
            name: "order_id",
            title: "Order ID",
            isRequired: true
          }, {
            type: "dropdown",
            name: "sample_type",
            title: "Sample Type",
            choices: ["Serum", "Plasma", "Whole Blood", "Urine"],
            isRequired: true
          }]
        }, {
          name: "collection",
          title: "Sample Collection",
          elements: [{
            type: "text",
            name: "collection_time",
            title: "Collection Time",
            inputType: "datetime-local",
            isRequired: true
          }, {
            type: "text",
            name: "volume_collected",
            title: "Volume Collected (mL)",
            inputType: "number",
            isRequired: true
          }, {
            type: "checkbox",
            name: "collection_checks",
            title: "Collection Checklist",
            choices: [
              "Patient fasted as required",
              "Proper tube used",
              "Sample labeled correctly",
              "No hemolysis observed"
            ],
            isRequired: true
          }]
        }]
      }
    },
    rules: {
      mode: "BASIC",
      triggerOn: "SAMPLE_COLLECT",
      steps: [
        { no: 1, type: "data_entry", required: true },
        { no: 2, type: "qc", required: true }
      ]
    },
    meta: {
      title: "Sample Collection",
      description: "Standard sample collection workflow with QC checks",
      owner: "Lab Operations",
      version: "1.0.0",
      tags: ["sample", "collection", "qc"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  },

  // Result verification workflow
  resultVerification: {
    ui: {
      engine: "surveyjs",
      template: {
        title: "Result Verification",
        description: "Verify and approve test results",
        pages: [{
          name: "review",
          title: "Result Review",
          elements: [{
            type: "html",
            html: "<h4>Review the following results before approval:</h4>"
          }, {
            type: "text",
            name: "test_result",
            title: "Test Result",
            readOnly: true
          }, {
            type: "text",
            name: "reference_range",
            title: "Reference Range",
            readOnly: true
          }, {
            type: "dropdown",
            name: "result_status",
            title: "Result Status",
            choices: [
              "Normal",
              "Abnormal - Low",
              "Abnormal - High",
              "Critical - Low", 
              "Critical - High"
            ],
            isRequired: true
          }]
        }, {
          name: "approval",
          title: "Approval",
          elements: [{
            type: "checkbox",
            name: "verification_checks",
            title: "Verification Checklist",
            choices: [
              "Result is within analytical range",
              "No technical errors observed",
              "Quality controls passed",
              "Patient demographics verified"
            ],
            isRequired: true
          }, {
            type: "dropdown",
            name: "approval_action",
            title: "Action",
            choices: [
              "Approve Result",
              "Request Repeat",
              "Request Dilution",
              "Contact Supervisor"
            ],
            isRequired: true
          }, {
            type: "comment",
            name: "approval_notes",
            title: "Notes"
          }]
        }]
      }
    },
    rules: {
      mode: "PRO",
      triggerOn: "RESULT_ENTRY",
      steps: [
        { no: 1, type: "data_entry", required: true },
        { no: 2, type: "approval", required: true, permissions: ["supervisor", "pathologist"] }
      ]
    },
    meta: {
      title: "Result Verification",
      description: "Professional result verification and approval workflow",
      owner: "Lab Medicine",
      version: "1.0.0",
      tags: ["results", "verification", "approval"],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }
};

// Helper function to create workflow versions in database
export const createSampleWorkflows = async () => {
  const { supabase } = await import('./supabase');
  
  const results = [];
  
  for (const [key, workflow] of Object.entries(SAMPLE_WORKFLOWS)) {
    try {
      const { data, error } = await supabase
        .from('workflow_versions')
        .insert({
          name: workflow.meta.title,
          description: workflow.meta.description,
          version: workflow.meta.version,
          definition: workflow,
          is_active: true,
          created_by: null // Will be set by RLS
        })
        .select('id, name')
        .single();

      if (error) {
        console.error(`Failed to create workflow ${key}:`, error);
        results.push({ key, success: false, error: error.message });
      } else {
        console.log(`Created workflow ${key}:`, data);
        results.push({ key, success: true, id: data.id, name: data.name });
      }
    } catch (err) {
      console.error(`Exception creating workflow ${key}:`, err);
      results.push({ key, success: false, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
  
  return results;
};