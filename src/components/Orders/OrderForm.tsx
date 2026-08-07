import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import {
  X,
  Search,
  Upload,
  CreditCard,
  User,
  Building,
  Briefcase,
  Plus,
  Calendar,
  TestTube,
  Sparkles,
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  Loader,
  Clock as ClockIcon,
  DollarSign,
  Gift,
  UserPlus,
  Truck,
  ChevronDown,
  Camera,
  Stethoscope
} from 'lucide-react';
import { database, supabase, formatAge, LabPatientFieldConfig, DEFAULT_PATIENT_FORM_SETTINGS, type LabPatientFormSettings } from '../../utils/supabase';
import { notificationTriggerService, formatName } from '../../utils/notificationTriggerService';
import { useQZTray } from '../../contexts/QZTrayContext';
import { SampleTypeIndicator } from '../Common/SampleTypeIndicator';
import { getLabCurrency } from '../../utils/currency';
import OnlinePaymentQR from '../Billing/OnlinePaymentQR';
import {
  processTRFImage,
  trfToOrderFormData,
  formatConfidence,
  validatePatientData,
  autoCreatePatientFromTRF,
  autoCreateDoctorFromTRF,
  findDoctorByName,
  validateTRFExtractionData,
  type TRFExtractionResult,
  type TRFProcessingProgress
} from '../../utils/trfProcessor';

type PaymentType = 'self' | 'credit' | 'insurance' | 'corporate';

interface Doctor {
  id: string;
  name: string;
  specialization?: string | null;
  default_discount_percent?: number | null;
}

interface Location {
  id: string;
  name: string;
  type: string; // 'hospital' | 'clinic' | 'diagnostic_center' | 'home_collection' | 'walk_in'
  credit_limit?: number | null;
  default_discount_percent?: number | null;
  collection_percentage?: number | null;
  receivable_type?: 'percentage' | 'test_wise' | 'own_center' | null;
}

interface Account {
  id: string;
  name: string;
  type: 'hospital' | 'corporate' | 'insurer' | 'clinic' | 'doctor' | 'other';
  default_discount_percent?: number | null;
  credit_limit?: number | null;
  payment_terms?: number | null;
  is_active?: boolean | null;
  billing_mode?: 'standard' | 'monthly' | null;
  is_locked?: boolean | null;
  lock_override_until?: string | null;
}

// An account is "effectively locked" (order creation blocked) when it is locked
// and any temporary open window has expired. Mirrors AccountMaster.
const isAccountEffectivelyLocked = (account?: Pick<Account, 'is_locked' | 'lock_override_until'> | null): boolean => {
  if (!account?.is_locked) return false;
  if (account.lock_override_until && new Date(account.lock_override_until).getTime() > Date.now()) return false;
  return true;
};

interface Patient {
  id: string;
  name: string;
  age?: number | null;
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
  default_doctor_id?: string | null;
  default_location_id?: string | null;
  default_payment_type?: PaymentType | null;
  age_unit?: string | null;
  dob?: string | null;
  date_of_birth?: string | null;
}

interface TestGroup {
  id: string;
  name: string;
  code?: string;
  price: number;
  category?: string | null;
  clinicalPurpose?: string | null;
  sampleType?: string | null;
  turnaroundTime?: string | null;
  tat_hours?: number | null;
  requiresFasting?: boolean | null;
  type?: 'test' | 'package';
  is_outsourced?: boolean;
  default_outsourced_lab_id?: string;
  description?: string | null;
  testGroupIds?: string[];
  sample_color?: string | null;
  sample_type?: string | null;
  required_patient_inputs?: string[];
  ref_range_ai_config?: any;
  collection_charge?: number | null;
}



interface AccountPrice {
  test_group_id: string;
  price: number;
}

interface OrderFormProps {
  onClose: () => void;
  onSubmit: (orderData: any) => void;
  onOrderCreated?: (orderId: string) => void;
  preSelectedPatientId?: string;
  initialBookingData?: any;
}

const OrderForm: React.FC<OrderFormProps> = ({ onClose, onSubmit, preSelectedPatientId, initialBookingData, onOrderCreated }) => {
  const { autoPrintBarcodes } = useQZTray();
  // Masters
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const patientInputRef = useRef<HTMLInputElement>(null);
  const doctorInputRef = useRef<HTMLInputElement>(null);
  const locationInputRef = useRef<HTMLInputElement>(null);
  const accountInputRef = useRef<HTMLInputElement>(null);
  const clinicalNotesRef = useRef<HTMLTextAreaElement>(null);
  const createOrderButtonRef = useRef<HTMLButtonElement>(null);
  const createAndNewButtonRef = useRef<HTMLButtonElement>(null);
  const submitModeRef = useRef<'close' | 'new'>('close');
  const modalScrollRef = useRef<HTMLDivElement>(null);
  const newPatientModalRef = useRef<HTMLDivElement>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]); // Combined test groups AND packages
  const [outsourcedLabs, setOutsourcedLabs] = useState<any[]>([]);

  // Loading flags
  const [loadingPatients, setLoadingPatients] = useState<boolean>(false);
  const [loadingDoctors, setLoadingDoctors] = useState<boolean>(false);
  const [loadingLocations, setLoadingLocations] = useState<boolean>(false);
  const [loadingAccounts, setLoadingAccounts] = useState<boolean>(false);
  const [loadingTests, setLoadingTests] = useState<boolean>(false);

  // Selecteds / data
  const SELF_DOCTOR_ID = 'SELF';

  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [selectedDoctor, setSelectedDoctor] = useState<string>('SELF');
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [selectedAccount, setSelectedAccount] = useState<string>(''); // bill-to account
  const [paymentType, setPaymentType] = useState<PaymentType>('self');
  const [priority, setPriority] = useState<'Normal' | 'Urgent' | 'STAT'>('Normal');
  const [orderDetailsOpen, setOrderDetailsOpen] = useState(false);
  const [clinicalNotesOpen, setClinicalNotesOpen] = useState(false);
  const [preBarcoded, setPreBarcoded] = useState(false);
  const [preBarcode, setPreBarcode] = useState('');
  const [expectedDate, setExpectedDate] = useState<string>(() =>
    new Date().toISOString().split('T')[0]
  );
  const [notes, setNotes] = useState<string>('');

  // Test selection
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [testSearch, setTestSearch] = useState<string>('');
  const [showTestList, setShowTestList] = useState<boolean>(false);

  // Outsourcing config per test: { testId: outsourcedLabId | 'inhouse' | null }
  const [testOutsourcingConfig, setTestOutsourcingConfig] = useState<Record<string, string>>({});

  // Account specific prices: { testGroupId: price }
  const [accountPrices, setAccountPrices] = useState<Record<string, number>>({});

  // Location specific prices: { testGroupId: { patient_price, lab_receivable } }
  const [locationPrices, setLocationPrices] = useState<Record<string, { patient_price: number; lab_receivable: number }>>({});

  // AI Reference Range Inputs
  const [additionalInputs, setAdditionalInputs] = useState<Record<string, string>>({});

  // Compute required patient inputs from selected tests
  const requiredInfos = React.useMemo(() => {
    const required = new Set<string>();
    testGroups
      .filter(tg => selectedTests.includes(tg.id))
      .forEach(tg => tg.required_patient_inputs?.forEach(input => required.add(input)));

    // Filter out inputs that don't apply (e.g., pregnancy for Male)
    if (selectedPatient?.gender === 'Male') {
      required.delete('pregnancy_status');
      required.delete('lmp');
    }

    return Array.from(required);
  }, [selectedTests, testGroups, selectedPatient]);

  // Loading and error states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [submissionProgress, setSubmissionProgress] = useState<string>('');

  // Custom patient field configs (searchable ones)
  const [searchablePatientFields, setSearchablePatientFields] = useState<LabPatientFieldConfig[]>([]);
  // All custom patient field configs (for Add New Patient modal)
  const [allPatientFieldConfigs, setAllPatientFieldConfigs] = useState<LabPatientFieldConfig[]>([]);
  const [newPatientCustomFields, setNewPatientCustomFields] = useState<Record<string, any>>({});

  // Searches / dropdown visibility
  const [patientSearch, setPatientSearch] = useState<string>('');
  const [highlightedPatientIndex, setHighlightedPatientIndex] = useState<number>(-1);
  const [highlightedDoctorIndex, setHighlightedDoctorIndex] = useState<number>(-1);
  const [highlightedLocationIndex, setHighlightedLocationIndex] = useState<number>(-1);
  const [highlightedAccountIndex, setHighlightedAccountIndex] = useState<number>(-1);
  const [doctorSearch, setDoctorSearch] = useState<string>('Self / Walk-in');
  const [locationSearch, setLocationSearch] = useState<string>('');
  const [accountSearch, setAccountSearch] = useState<string>('');

  // Admin features
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [customOrderDate, setCustomOrderDate] = useState<string>('');
  const [customReportDate, setCustomReportDate] = useState<string>('');
  const [showPatientDropdown, setShowPatientDropdown] = useState<boolean>(false);
  const [showDoctorDropdown, setShowDoctorDropdown] = useState<boolean>(false);
  const [showLocationDropdown, setShowLocationDropdown] = useState<boolean>(false);
  const [showAccountDropdown, setShowAccountDropdown] = useState<boolean>(false);

  // Test request form
  const [testRequestFile, setTestRequestFile] = useState<File | null>(null);

  // TRF AI Processing
  const [processingTRF, setProcessingTRF] = useState<boolean>(false);
  const [trfProgress, setTrfProgress] = useState<TRFProcessingProgress | null>(null);
  const [trfExtraction, setTrfExtraction] = useState<TRFExtractionResult | null>(null);
  const [showTRFReview, setShowTRFReview] = useState<boolean>(false);
  const [trfUnmatchedTests, setTrfUnmatchedTests] = useState<string[]>([]);
  const [enableTRFOptimization, setEnableTRFOptimization] = useState<boolean>(true); // Image optimization
  const [trfCreateNewDoctor, setTrfCreateNewDoctor] = useState<boolean>(false); // Whether to create new doctor from TRF


  // Currency
  const [currencySymbol, setCurrencySymbol] = useState<string>('₹');

  // Discount & Payment
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>('percentage');
  const [discountValue, setDiscountValue] = useState<number>(0);
  const [discountBy, setDiscountBy] = useState<'lab' | 'doctor'>('lab');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'upi' | 'online'>('cash');
  const [amountPaid, setAmountPaid] = useState<number>(0);
  const [takeFullPayment, setTakeFullPayment] = useState<boolean>(false);

  // 'online' is collected through the payment gateway after the invoice exists,
  // so it can't be recorded as a settled payment at submit time.
  const isOnlineCollection = paymentMethod === 'online' && amountPaid > 0;

  const [onlineCollection, setOnlineCollection] = useState<{
    invoiceId: string;
    invoiceNumber: string | null;
    labId: string;
    patientId: string;
    patientName: string;
    patientPhone?: string;
    amount: number;
  } | null>(null);

  // Quick-Add Doctor modal
  const [showAddDoctorModal, setShowAddDoctorModal] = useState<boolean>(false);
  const [newDoctorData, setNewDoctorData] = useState({ name: '', specialization: '', phone: '', hospital: '' });
  const [addingDoctor, setAddingDoctor] = useState<boolean>(false);

  // Sample Collection Charge
  const [collectionCharge, setCollectionCharge] = useState<number>(0);

  // Lab Billing Items (extra charges)
  interface BillingItemType { id: string; name: string; default_amount: number; is_shareable_with_doctor: boolean; is_shareable_with_phlebotomist: boolean; }
  interface SelectedBillingItem { typeId: string | null; name: string; amount: number; is_shareable_with_doctor: boolean; is_shareable_with_phlebotomist: boolean; }
  const [billingItemTypes, setBillingItemTypes] = useState<BillingItemType[]>([]);
  const [selectedBillingItems, setSelectedBillingItems] = useState<SelectedBillingItem[]>([]);
  const [showAddBillingItem, setShowAddBillingItem] = useState(false);
  const [newBillingItemTypeId, setNewBillingItemTypeId] = useState('');
  const [newBillingItemName, setNewBillingItemName] = useState('');
  const [newBillingItemAmount, setNewBillingItemAmount] = useState('');
  const extraChargesTotal = selectedBillingItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  // Loyalty Points
  const [loyaltyEnabled, setLoyaltyEnabled] = useState<boolean>(false);
  const [loyaltyBalance, setLoyaltyBalance] = useState<number>(0);
  const [loyaltyMinRedeem, setLoyaltyMinRedeem] = useState<number>(100);
  const [loyaltyPointValue, setLoyaltyPointValue] = useState<number>(1.0);
  const [loyaltyPointsToRedeem, setLoyaltyPointsToRedeem] = useState<number>(0);
  const [loyaltyRedeemEnabled, setLoyaltyRedeemEnabled] = useState<boolean>(false);

  /**
   * Resolve the price for a test/package based on priority:
   * 1. Account price (B2B) - highest priority
   * 2. Location price (franchise) - if location has custom pricing
   * 3. Base price - fallback
   * 
   * Also returns lab_receivable for location pricing (what the lab receives from the location)
   * - If test has explicit lab_receivable in location_test_prices → use that
   * - Otherwise calculate from collection_percentage
   */
  const resolvePrice = React.useCallback((testId: string, basePrice: number): { price: number; source: 'account' | 'location' | 'base'; labReceivable?: number } => {
    // Priority 1: Account price (B2B billing)
    if (selectedAccount && accountPrices[testId] !== undefined) {
      return { price: accountPrices[testId], source: 'account' };
    }
    
    const location = selectedLocation ? locations.find(l => l.id === selectedLocation) : null;
    
    // Priority 2: Location price (franchise/collection center pricing)
    if (selectedLocation && locationPrices[testId]) {
      const locPrice = locationPrices[testId];
      
      // Calculate labReceivable:
      // 1. If explicitly set in location_test_prices, use it
      // 2. Otherwise calculate from collection_percentage
      let labReceivable = locPrice.lab_receivable;
      if (labReceivable === null || labReceivable === undefined) {
        if (location?.receivable_type === 'own_center') {
          labReceivable = locPrice.patient_price; // Lab gets 100%
        } else if (location?.collection_percentage) {
          labReceivable = locPrice.patient_price * (location.collection_percentage / 100);
        }
      }
      
      return { 
        price: locPrice.patient_price, 
        source: 'location',
        labReceivable: labReceivable ?? undefined
      };
    }
    
    // Priority 3: Base price - but if location selected, calculate receivable from percentage
    if (location && location.receivable_type !== 'own_center') {
      let labReceivable: number | undefined = undefined;
      if (location.collection_percentage) {
        labReceivable = (basePrice ?? 0) * (location.collection_percentage / 100);
      }
      return { price: basePrice ?? 0, source: 'base', labReceivable };
    }
    
    // No location or own_center = lab gets 100%
    return { price: basePrice ?? 0, source: 'base' };
  }, [selectedAccount, accountPrices, selectedLocation, locationPrices, locations]);


  // Handle TRF modal close and apply edited values
  const handleTRFReviewClose = async () => {
    setShowTRFReview(false);

    console.log('🚀🚀🚀 NEW CODE LOADED - handleTRFReviewClose called 🚀🚀🚀');

    // If we have trfExtraction data, apply it (edited or original)
    if (trfExtraction && trfExtraction.success) {
      console.log('Applying TRF extraction data (including any edits)...');

      // Check if we have a matched patient from the TRF extraction
      if (trfExtraction.matchedPatient && trfExtraction.matchedPatient.matchConfidence >= 0.7) {
        // Use matched patient if confidence is >= 70%
        console.log(`Using matched patient (${Math.round(trfExtraction.matchedPatient.matchConfidence * 100)}% confidence):`, trfExtraction.matchedPatient.name);

        const matched = patients.find(p => p.id === trfExtraction.matchedPatient!.id);
        if (matched) {
          setSelectedPatient(matched);
          setPatientSearch(matched.name);
          onPickPatient(matched);
          console.log('✓ Matched patient selected:', matched.name);
        } else {
          console.warn('Matched patient not found in patients list, will need to refresh');
          // Refresh patients and try again
          const { data: refreshedPatients } = await database.patients.getAll();
          if (refreshedPatients && Array.isArray(refreshedPatients)) {
            setPatients(refreshedPatients);
            const matched = refreshedPatients.find((p: any) => p.id === trfExtraction.matchedPatient!.id);
            if (matched) {
              setSelectedPatient(matched);
              setPatientSearch(matched.name);
              onPickPatient(matched);
              console.log('✓ Matched patient selected after refresh:', matched.name);
            }
          }
        }
      } else if (trfExtraction.patientInfo) {
        // No matched patient or low confidence - create new patient with edited values
        const validation = validatePatientData(trfExtraction.patientInfo);

        if (validation.isValid) {
          console.log('Creating NEW patient with edited values from TRF (no match or low confidence)...');

          // Get current user's lab_id
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: userRecord } = await supabase
              .from('users')
              .select('lab_id')
              .eq('id', user.id)
              .single();

            if (userRecord?.lab_id) {
              // Create new patient with edited data (include ageUnit from modal)
              const patientData = {
                ...trfExtraction.patientInfo,
                ageUnit: (trfExtraction as any).patientInfo?.ageUnit || 'years'
              };
              const newPatient = await autoCreatePatientFromTRF(
                patientData,
                userRecord.lab_id
              );

              if (newPatient) {
                console.log('✓ Patient created in database:', newPatient);

                // Refresh patients list
                const { data: refreshedPatients } = await database.patients.getAll();
                if (refreshedPatients && Array.isArray(refreshedPatients)) {
                  setPatients(refreshedPatients);

                  // Try to find in refreshed list
                  const created = refreshedPatients.find((p: any) => p.id === newPatient.id);
                  if (created) {
                    setSelectedPatient(created);
                    setPatientSearch(created.name);
                    onPickPatient(created);
                    console.log('✓ Patient selected from refreshed list:', created.name);
                  } else {
                    // Fallback: use the newly created patient directly
                    console.warn('Patient not found in refreshed list, using direct reference');
                    setSelectedPatient(newPatient as any);
                    setPatientSearch(newPatient.name);
                    onPickPatient(newPatient as any);
                    console.log('✓ Patient selected directly:', newPatient.name);
                  }
                } else {
                  // Still use the newly created patient
                  setSelectedPatient(newPatient as any);
                  setPatientSearch(newPatient.name);
                  onPickPatient(newPatient as any);
                  console.log('✓ Patient selected (list refresh failed):', newPatient.name);
                }
              } else {
                console.error('autoCreatePatientFromTRF returned null - check console for errors');
              }
            } else {
              console.error('User lab_id not found');
            }
          }
        } else {
          console.log('Patient data incomplete after editing, missing:', validation.missing);
          // Still show the data in search field
          if (trfExtraction.patientInfo.name) {
            setPatientSearch(trfExtraction.patientInfo.name);
          }
        }
      }

      // Use matched doctor from TRF extraction (already matched in edge function)
      if (trfExtraction.matchedDoctor && trfExtraction.matchedDoctor.matchConfidence >= 0.7) {
        // Use matched doctor if confidence is >= 70%
        console.log(`✓ Using matched doctor (${Math.round(trfExtraction.matchedDoctor.matchConfidence * 100)}% confidence):`, trfExtraction.matchedDoctor.name);
        setSelectedDoctor(trfExtraction.matchedDoctor.id);
      } else if (trfExtraction.doctorInfo?.name) {
        // No match or low confidence - check if user wants to create new doctor
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: userRecord } = await supabase
            .from('users')
            .select('lab_id')
            .eq('id', user.id)
            .single();

          if (userRecord?.lab_id) {
            // First try to find existing doctor
            const matchedDoctor = await findDoctorByName(
              trfExtraction.doctorInfo.name,
              userRecord.lab_id
            );

            if (matchedDoctor) {
              setSelectedDoctor(matchedDoctor.id);
              console.log('✓ Matched doctor with manual search:', matchedDoctor.name);
            } else if (trfCreateNewDoctor && trfExtraction.doctorInfo.name.trim().length >= 2) {
              // User opted to create new doctor
              console.log('Creating NEW doctor from TRF:', trfExtraction.doctorInfo.name);
              const newDoctor = await autoCreateDoctorFromTRF(
                trfExtraction.doctorInfo,
                userRecord.lab_id
              );

              if (newDoctor) {
                console.log('✓ Doctor created successfully:', newDoctor);
                // Refresh doctors list
                const { data: refreshedDoctors } = await database.doctors.getAll();
                if (refreshedDoctors) {
                  setDoctors(refreshedDoctors);
                }
                setSelectedDoctor(newDoctor.id);
              } else {
                console.error('Failed to create doctor from TRF');
              }
            } else {
              console.log('⚠ No matching doctor found and user did not opt to create:', trfExtraction.doctorInfo.name);
            }
          }
        }
      }

      // Reset the create new doctor flag
      setTrfCreateNewDoctor(false);

      // Apply edited test selections (only selected tests)
      if (trfExtraction.requestedTests) {
        const selectedTestIds = trfExtraction.requestedTests
          .filter(test => test.isSelected && test.testGroupId)
          .map(test => test.testGroupId!);

        if (selectedTestIds.length > 0) {
          console.log(`✓ Applying ${selectedTestIds.length} test selections from TRF`);
          console.log(`  Test Group IDs from TRF:`, selectedTestIds);
          console.log(`  Available test groups in state:`, testGroups.length);
          console.log(`  First TRF test ID:`, selectedTestIds[0]);
          console.log(`  First testGroup in state:`, testGroups[0]);
          console.log(`  Sample of testGroup IDs in state:`, testGroups.slice(0, 10).map(tg => tg.id));

          // Check how many match
          const matchedGroups = testGroups.filter(tg => selectedTestIds.includes(tg.id));
          console.log(`  ✓ Matched ${matchedGroups.length}/${selectedTestIds.length} tests`);
          if (matchedGroups.length > 0) {
            console.log(`  Matched tests:`, matchedGroups.map(tg => ({ name: tg.name, price: tg.price })));
          } else {
            console.log(`  ❌ NO MATCHES! Checking if IDs exist anywhere...`);
            const firstTrfId = selectedTestIds[0];
            const foundInState = testGroups.find(tg => tg.id === firstTrfId);
            console.log(`  Looking for "${firstTrfId}" in testGroups:`, foundInState ? 'FOUND' : 'NOT FOUND');
          }
          setSelectedTests(selectedTestIds);
        }

        // Track unmatched tests
        const unmatchedTests = trfExtraction.requestedTests.filter(test => !test.matched);
        if (unmatchedTests.length > 0) {
          setTrfUnmatchedTests(unmatchedTests.map(t => t.testName));
          console.log(`⚠ ${unmatchedTests.length} tests still need manual selection`);
        }
      }

      // Apply edited clinical notes
      if (trfExtraction.clinicalNotes) {
        setNotes(trfExtraction.clinicalNotes);
      }

      // Apply edited urgency
      if (trfExtraction.urgency) {
        setPriority(trfExtraction.urgency);
      }
    }
  };

  // Credit validation (either Location or Account, whichever is chosen)
  const [creditInfo, setCreditInfo] = useState<{
    kind: 'location' | 'account';
    allowed: boolean;
    currentBalance: number;
    creditLimit: number;
    availableCredit: number;
    /** Cash/cheque receipted against the account from Account Master */
    manualPaymentCredit?: number;
    name: string;
  } | null>(null);

  // Patient form settings (lab-configurable)
  const [patientFormSettings, setPatientFormSettings] = useState<LabPatientFormSettings>(DEFAULT_PATIENT_FORM_SETTINGS);

  // New patient modal
  const [showNewPatientModal, setShowNewPatientModal] = useState<boolean>(false);
  const [creatingPatient, setCreatingPatient] = useState<boolean>(false);
  const [nameCaseFormat, setNameCaseFormat] = useState<'proper' | 'upper'>('proper');
  const npNameInputStyle = nameCaseFormat === 'upper' ? { textTransform: 'uppercase' as const } : undefined;
  const [autoCollectOnRegistration, setAutoCollectOnRegistration] = useState(false);
  const [newPatient, setNewPatient] = useState<{
    name: string;
    age: string;
    age_unit: 'years' | 'months' | 'days';
    gender: string;
    phone: string;
    email: string;
    dob: string;
  }>({ name: '', age: '', age_unit: 'years', gender: 'Male', phone: '', email: '', dob: '' });

  // Split name fields for Add Patient form
  const NP_SALUTATIONS = patientFormSettings.salutation_options;
  const [npSalutation, setNpSalutation] = useState('');
  const [npFirstName, setNpFirstName] = useState('');
  const [npMiddleName, setNpMiddleName] = useState('');
  const [npLastName, setNpLastName] = useState('');
  const [npGenderAutoDetected, setNpGenderAutoDetected] = useState(false);
  const [npGenderManuallySet, setNpGenderManuallySet] = useState(false);

  const npDetectGender = (sal: string, first: string, last: string): 'Male' | 'Female' | '' => {
    const s = sal.toLowerCase().replace('.', '');
    if (['mr', 'master', 'shri', 'shriman'].includes(s)) return 'Male';
    if (['mrs', 'ms', 'miss', 'smt', 'shrimati', 'ku', 'kumari', 'baby'].includes(s)) return 'Female';
    const words = `${first} ${last}`.toLowerCase().split(/\s+/);
    const female = ['ben', 'bhen', 'bai', 'devi', 'kumari', 'shrimati', 'smt', 'sister', 'mata', 'amma', 'didi'];
    const male = ['bhai', 'bro', 'shriman', 'lal', 'singh', 'ram', 'kumar'];
    if (words.some(w => female.includes(w))) return 'Female';
    if (words.some(w => male.includes(w))) return 'Male';
    return '';
  };

  const npGetFullName = () =>
    [npSalutation, npFirstName.trim(), npMiddleName.trim(), npLastName.trim()].filter(Boolean).join(' ');

  const npResetNameFields = () => {
    setNpSalutation(''); setNpFirstName(''); setNpMiddleName(''); setNpLastName('');
    setNpGenderAutoDetected(false); setNpGenderManuallySet(false);
  };

  // Auto-detect gender when split name fields change (skipped if user manually picked)
  useEffect(() => {
    if (!npGenderManuallySet) {
      const detected = npDetectGender(npSalutation, npFirstName, npLastName);
      if (detected) {
        setNewPatient(p => ({ ...p, gender: detected }));
        setNpGenderAutoDetected(true);
      }
    }
    // Always sync composed name
    const full = npGetFullName();
    if (full) setNewPatient(p => ({ ...p, name: full }));
  }, [npSalutation, npFirstName, npMiddleName, npLastName]);

  const calcAgeFromDob = (dob: string): { age: string; age_unit: 'years' | 'months' | 'days' } => {
    const birth = new Date(dob);
    const today = new Date();
    const diffDays = Math.floor((today.getTime() - birth.getTime()) / 86400000);
    if (diffDays < 30) return { age: String(diffDays), age_unit: 'days' };
    if (diffDays < 365) return { age: String(Math.floor(diffDays / 30.44)), age_unit: 'months' };
    return { age: String(Math.floor(diffDays / 365.25)), age_unit: 'years' };
  };

  // Load name case format, workflow settings, and patient form settings from lab
  useEffect(() => {
    database.getCurrentUserLabId().then(async labId => {
      if (!labId) return;
      notificationTriggerService.getSettings(labId).then(s => {
        if (s?.name_case_format) setNameCaseFormat(s.name_case_format);
      });
      const { data: labData } = await supabase.from('labs').select('auto_collect_on_registration').eq('id', labId).single();
      if (labData?.auto_collect_on_registration) setAutoCollectOnRegistration(true);
    }).catch(() => {});

    database.patientFormSettings.get().then(({ data }) => {
      if (data) setPatientFormSettings(s => ({ ...s, ...data }));
    }).catch(() => {});
  }, []);

  // Pre-fill from Booking Data
  useEffect(() => {
    if (initialBookingData) {
      console.log('Pre-filling Order Form from Booking:', initialBookingData);

      // 1. Patient Info (Loose text -> manual entry mode primarily)
      if (initialBookingData.patient_info) {
        // Update newPatient state object
        setNewPatient(prev => ({
          ...prev,
          name: initialBookingData.patient_info.name || '',
          phone: initialBookingData.patient_info.phone || '',
          gender: initialBookingData.patient_info.gender || 'Male',
          age: initialBookingData.patient_info.age?.toString() || '',
          email: initialBookingData.patient_info.email || prev.email
        }));

        // Also set search so it looks like a manual entry
        setPatientSearch(initialBookingData.patient_info.name || '');
      }

      // 2. Tests
      if (initialBookingData.test_details && Array.isArray(initialBookingData.test_details)) {
        const testIds = initialBookingData.test_details.filter((t: any) => t.id).map((t: any) => t.id);
        setSelectedTests(testIds);
      }

      // 3. Collection Type
      if (initialBookingData.collection_type === 'home_collection' && initialBookingData.home_collection_address) {
        // You might set a note or handle home collection specific logic here if fields exist
        setNotes(`Home Collection Address: ${initialBookingData.home_collection_address.address}, ${initialBookingData.home_collection_address.city}`);
      }

      // 4. B2B Account — auto-select bill-to account and set payment type to credit
      if (initialBookingData.account_id && accounts.length > 0) {
        const matchedAccount = accounts.find((a) => a.id === initialBookingData.account_id);
        if (matchedAccount) {
          setSelectedAccount(matchedAccount.id);
          setAccountSearch(matchedAccount.name);
          setPaymentType('credit');
        }
      }
    }
  }, [initialBookingData, accounts]);

  // ✅ OPTIMIZED: Search patients on-demand instead of preloading all
  const searchPatients = async (query: string) => {
    if (query.length < 2) {
      setPatients([]);
      return;
    }

    setLoadingPatients(true);
    try {
      const labId = await database.getCurrentUserLabId();
      const patientSelect = 'id, name, phone, age, gender, age_unit, dob, date_of_birth, default_doctor_id, default_location_id, default_payment_type, custom_fields';

      // Main query: name + phone
      const mainQuery = supabase
        .from('patients')
        .select(patientSelect)
        .eq('lab_id', labId)
        .eq('is_active', true)
        .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
        .order('name')
        .limit(20);

      // Custom fields search: filter on the stored generated column custom_fields_text
      // (PostgREST does not support ::text cast in filter column names)
      const customFieldQueries = searchablePatientFields.length > 0 ? [
        supabase
          .from('patients')
          .select(patientSelect)
          .eq('lab_id', labId)
          .eq('is_active', true)
          .ilike('custom_fields_text', `%${query}%`)
          .limit(20)
      ] : [];

      const [mainResult, ...customResults] = await Promise.all([mainQuery, ...customFieldQueries]);

      // Merge and deduplicate by id
      const seen = new Set<string>();
      const merged: any[] = [];
      for (const p of [...(mainResult.data || []), ...customResults.flatMap(r => r.data || [])]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          merged.push(p);
        }
      }
      merged.sort((a, b) => a.name.localeCompare(b.name));

      setPatients(merged as Patient[]);
    } catch (err) {
      console.error('Error searching patients:', err);
    } finally {
      setLoadingPatients(false);
    }
  };

  // Debounce patient search
  const patientSearchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (patientSearchTimeoutRef.current) {
      clearTimeout(patientSearchTimeoutRef.current);
    }

    if (patientSearch.length >= 2) {
      patientSearchTimeoutRef.current = setTimeout(() => {
        searchPatients(patientSearch);
      }, 300); // 300ms debounce
    } else {
      setPatients([]);
    }

    return () => {
      if (patientSearchTimeoutRef.current) {
        clearTimeout(patientSearchTimeoutRef.current);
      }
    };
  }, [patientSearch]);

  // Initial loads - ✅ OPTIMIZED: Removed patients.getAll() - now on-demand
  useEffect(() => {
    const fetchMasters = async () => {
      try {
        setLoadingDoctors(true);
        setLoadingLocations(true);
        setLoadingAccounts(true);
        setLoadingTests(true);

        // ✅ OPTIMIZED: 6 parallel calls instead of 7 (removed patients)
        const [
          doctorsRes,
          locationsRes,
          accountsRes,
          testsRes,
          packagesRes,
          outsourcedLabsRes
        ] = await Promise.all([
          (database as any).doctors?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).locations?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).accounts?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).testGroups?.getAll?.() ?? Promise.resolve({ data: [] }),
          (database as any).packages?.getAll?.() ?? Promise.resolve({ data: [] }),
          supabase.from('outsourced_labs').select('*').eq('is_active', true).order('name')
        ]);

        setDoctors(doctorsRes?.data ?? []);
        setLocations(locationsRes?.data ?? []);
        setAccounts(accountsRes?.data ?? []);

        // Combine test groups and packages into a single list
        const testGroupsList = (testsRes?.data ?? []).map((tg: any) => ({
          ...tg,
          type: 'test' as const
        }));

        const packagesList = (packagesRes?.data ?? []).map((pkg: any) => ({
          id: pkg.id,
          name: pkg.name,
          price: pkg.price,
          category: pkg.category || 'Package',
          description: pkg.description,
          type: 'package' as const,
          testGroupIds: pkg.package_test_groups?.map((ptg: any) => ptg.test_group_id) || [],
          clinicalPurpose: pkg.description,
          sampleType: 'Various',
          turnaroundTime: null,
          requiresFasting: false,
          is_outsourced: false,
          default_outsourced_lab_id: undefined
        }));

        // Set combined list - packages first, then test groups
        setTestGroups([...packagesList, ...testGroupsList]);
        setOutsourcedLabs(outsourcedLabsRes?.data ?? []);

        // Load searchable custom patient fields
        const searchableFields = await database.labPatientFieldConfigs.getSearchable();
        setSearchablePatientFields(searchableFields);

        // Load all custom patient field configs for Add New Patient modal
        const { data: allFields } = await database.labPatientFieldConfigs.getAll();
        if (allFields) setAllPatientFieldConfigs(allFields);

        // Auto-select user's primary location if no patient is pre-selected
        if (!preSelectedPatientId) {
          const primaryLocation = await database.getCurrentUserPrimaryLocation();
          if (primaryLocation) {
            setSelectedLocation(primaryLocation);
          }
        }
      } catch (err) {
        console.error('Error loading masters:', err);
      } finally {
        setLoadingDoctors(false);
        setLoadingLocations(false);
        setLoadingAccounts(false);
        setLoadingTests(false);
      }
    };

    fetchMasters();
  }, []);

  // Pre-select patient (if provided)
  useEffect(() => {
    const loadPatient = async (patientId: string) => {
      try {
        const { data, error } = await (database as any).patients?.getById?.(patientId);
        if (error) throw error;
        if (data) {
          setSelectedPatient(data as Patient);
          if (data.default_doctor_id) {
            setSelectedDoctor(data.default_doctor_id);
            setDoctorSearch(data.referring_doctor_name || data.default_doctor?.name || '');
          } else {
            setSelectedDoctor('SELF');
            setDoctorSearch('Self / Walk-in');
          }
          if (data.default_location_id) setSelectedLocation(data.default_location_id);
          if (data.default_payment_type) setPaymentType(data.default_payment_type);
        }
      } catch (err) {
        console.error('Error loading patient:', err);
      }
    };

    if (preSelectedPatientId) loadPatient(preSelectedPatientId);
  }, [preSelectedPatientId]);

  // Re-check credit when bill-to changes under non-self payment types
  useEffect(() => {
    const check = async () => {
      if (paymentType === 'self') {
        setCreditInfo(null);
        return;
      }
      if (selectedAccount && (database as any).accounts?.checkCreditLimit) {
        try {
          const res = await (database as any).accounts.checkCreditLimit(selectedAccount, 0);
          if (res) {
            setCreditInfo({
              kind: 'account',
              allowed: !!res.allowed,
              currentBalance: Number(res.currentBalance ?? 0),
              creditLimit: Number(res.creditLimit ?? 0),
              availableCredit: Number(res.availableCredit ?? 0),
              manualPaymentCredit: Number(res.manualPaymentCredit ?? 0),
              name:
                res.name ||
                (accounts.find((a) => a.id === selectedAccount)?.name ?? 'Account')
            });
            return;
          }
        } catch (e) {
          console.error('Error checking account credit limit:', e);
        }
      }
      if (selectedLocation && (database as any).locations?.checkCreditLimit) {
        try {
          const res = await (database as any).locations.checkCreditLimit(selectedLocation, 0);
          if (res) {
            setCreditInfo({
              kind: 'location',
              allowed: !!res.allowed,
              currentBalance: Number(res.currentBalance ?? 0),
              creditLimit: Number(res.creditLimit ?? 0),
              availableCredit: Number(res.availableCredit ?? 0),
              name:
                res.name ||
                (locations.find((l) => l.id === selectedLocation)?.name ?? 'Location')
            });
            return;
          }
        } catch (e) {
          console.error('Error checking location credit limit:', e);
        }
      }
      setCreditInfo(null);
    };

    check();
  }, [selectedAccount, selectedLocation, paymentType, accounts, locations]);

  // Fetch account prices when bill-to account changes
    useEffect(() => {
      const fetchAccountPrices = async () => {
        if (!selectedAccount) {
          setAccountPrices({});
          return;
        }

        try {
        const { testPrices } = await (database as any).pricingHelper.getPriceMatrix({
          accountId: selectedAccount,
        });

        const priceMap: Record<string, number> = {};
        Object.entries(testPrices || {}).forEach(([testGroupId, value]: [string, any]) => {
          priceMap[testGroupId] = Number(value.price || 0);
        });
        setAccountPrices(priceMap);
        } catch (err) {
          console.error('Error fetching account prices:', err);
        }
      };

    fetchAccountPrices();
  }, [selectedAccount]);

  // Fetch location prices when location changes
  useEffect(() => {
    const fetchLocationPrices = async () => {
      if (!selectedLocation) {
        setLocationPrices({});
        return;
      }

      try {
        // Get effective location test prices
        const { data, error } = await supabase
          .from('location_test_prices')
          .select('test_group_id, patient_price, lab_receivable')
          .eq('location_id', selectedLocation)
          .eq('is_active', true)
          .lte('effective_from', new Date().toISOString());

        if (error) throw error;

        const priceMap: Record<string, { patient_price: number; lab_receivable: number }> = {};
        if (data) {
          // Use the most recent effective price per test
          const sortedData = [...data].sort((a, b) => 
            new Date(b.effective_from || 0).getTime() - new Date(a.effective_from || 0).getTime()
          );
          
          sortedData.forEach((item: any) => {
            if (!priceMap[item.test_group_id]) {
              priceMap[item.test_group_id] = {
                patient_price: item.patient_price,
                lab_receivable: item.lab_receivable
              };
            }
          });
        }
        setLocationPrices(priceMap);
      } catch (err) {
        console.error('Error fetching location prices:', err);
      }
    };

    fetchLocationPrices();
  }, [selectedLocation]);

  // Check for Admin Role
  useEffect(() => {
    const checkRole = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        console.log('OrderForm: Current User Check', user?.email, user?.user_metadata);

        let role = user?.user_metadata?.role;

        // Fallback: Check public users table if metadata missing
        if (!role && user?.email) {
          const { data: dbUser } = await supabase
            .from('users')
            .select('role')
            .eq('email', user.email)
            .eq('status', 'Active')
            .single();

          console.log('OrderForm: DB User Role Check', dbUser);
          if (dbUser?.role) role = dbUser.role;
        }

        console.log('OrderForm: Resolved Role', role);

        // Allow Admin, Lab Manager, Super Admin, Owner
        if (role) {
          const lowerRole = String(role).toLowerCase();
          const authorizedRoles = ['admin', 'administrator', 'super admin', 'lab_manager', 'owner', 'manager'];

          if (authorizedRoles.some(r => lowerRole.includes(r))) {
            console.log('OrderForm: Access GRANTED for role:', role);
            setIsAdmin(true);
          } else {
            console.log('OrderForm: Access DENIED for role:', role);
          }
        }
      } catch (err) {
        console.error('OrderForm: Role check failed', err);
      }
    };
    checkRole();
  }, []);

  // Debug: Monitor isAdmin state
  useEffect(() => {
    console.log('OrderForm: isAdmin state changed to:', isAdmin);
  }, [isAdmin]);

  // Filtering helpers
  const filteredPatients = patients.filter((p) => {
    const q = patientSearch.toLowerCase().trim();
    if (!q) return true;
    if (p.name?.toLowerCase().includes(q)) return true;
    if ((p.phone ?? '').includes(q)) return true;
    if (p.id?.includes(q)) return true;
    // Also pass through patients that matched via custom fields search
    const cf = (p as any).custom_fields;
    if (cf && typeof cf === 'object') {
      return Object.values(cf).some(v => String(v ?? '').toLowerCase().includes(q));
    }
    return false;
  });

  const filteredDoctors = doctors.filter((d) => {
    const q = doctorSearch.toLowerCase().trim();
    return !q || (d.name + ' ' + (d.specialization ?? '')).toLowerCase().includes(q);
  });

  const filteredLocations = locations.filter((l) => {
    const q = locationSearch.toLowerCase().trim();
    return !q || (l.name + ' ' + l.type).toLowerCase().includes(q);
  });

  const filteredAccounts = accounts.filter((a) => {
    const q = accountSearch.toLowerCase().trim();
    return !q || (a.name + ' ' + a.type).toLowerCase().includes(q);
  });

  // Handlers
  const onPickPatient = (p: Patient) => {
    setSelectedPatient(p);
    setPatientSearch('');
    setShowPatientDropdown(false);
    // Prefill defaults
    if (p.default_doctor_id) {
      setSelectedDoctor(p.default_doctor_id);
      setDoctorSearch(doctors.find(d => d.id === p.default_doctor_id)?.name || '');
    } else {
      setSelectedDoctor('SELF');
      setDoctorSearch('Self / Walk-in');
    }
    if (p.default_location_id) setSelectedLocation(p.default_location_id);
    if (p.default_payment_type) setPaymentType(p.default_payment_type);
    // Auto-advance focus to test search
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const createPatientFromBooking = async (): Promise<Patient | null> => {
    const info = initialBookingData?.patient_info;
    const name = String(info?.name || '').trim();

    if (!name) return null;

    const ageValue = parseInt(String(info?.age || newPatient.age || '0'), 10);
    const payload: any = {
      name: formatName(name, nameCaseFormat),
      age: Number.isFinite(ageValue) ? ageValue : 0,
      age_unit: info?.age_unit || newPatient.age_unit || 'years',
      gender: info?.gender || newPatient.gender || 'Male',
      phone: String(info?.phone || newPatient.phone || '').trim(),
      email: info?.email || newPatient.email || null,
      date_of_birth: info?.dob || info?.date_of_birth || newPatient.dob || null,
      custom_fields: info?.custom_fields || null,
      address: info?.address || '',
      city: info?.city || '',
      state: info?.state || '',
      pincode: info?.pincode || '',
      emergency_contact: null,
      emergency_phone: null,
      blood_group: null,
      allergies: null,
      medical_history: null,
      total_tests: 0,
      is_active: true,
      referring_doctor: null,
      default_doctor_id: (selectedDoctor && selectedDoctor !== SELF_DOCTOR_ID) ? selectedDoctor : null,
      default_location_id: selectedLocation || null,
      default_payment_type: paymentType || 'credit',
    };

    const { data, error } = await (database as any).patients?.create?.(payload);
    if (error) throw error;
    if (!data) return null;

    setPatients((prev) => [...prev, data]);
    onPickPatient(data as Patient);
    return data as Patient;
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('File size must be less than 10MB');
      return;
    }

    setTestRequestFile(file);

    // Auto-process TRF with AI
    if (file.type.startsWith('image/') || file.type === 'application/pdf') {
      setProcessingTRF(true);
      setTrfExtraction(null);
      setTrfProgress(null);

      try {
        const result = await processTRFImage(file, (progress) => {
          setTrfProgress(progress);
        }, {
          enableOptimization: enableTRFOptimization
        });

        if (result.success) {
          setTrfExtraction(result);
          setShowTRFReview(true);

          // Auto-populate form if confidence is high
          const formData = trfToOrderFormData(result);

          // Patient handling: auto-match or auto-create
          if (formData.matchedPatientId && formData.matchConfidence >= 0.7) {
            // High confidence match (≥70%) - auto-select existing patient
            const matched = patients.find(p => p.id === formData.matchedPatientId);
            if (matched) {
              setSelectedPatient(matched);
              setPatientSearch(matched.name);
              onPickPatient(matched);
              console.log('✓ Auto-selected matched patient (confidence:', formData.matchConfidence, '):', matched.name);
            }
          } else if (result.patientInfo?.name) {
            // No match or low confidence — patient will be created in handleTRFReviewClose
            // after user reviews the extracted data. Just pre-fill the search field.
            setPatientSearch(result.patientInfo.name);
          }

          // Doctor handling: find existing doctor (don't create new)
          if (result.doctorInfo?.name) {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
              const { data: userRecord } = await supabase
                .from('users')
                .select('lab_id')
                .eq('id', user.id)
                .single();

              if (userRecord?.lab_id) {
                const matchedDoctor = await findDoctorByName(
                  result.doctorInfo.name,
                  userRecord.lab_id
                );

                if (matchedDoctor) {
                  setSelectedDoctor(matchedDoctor.id);
                  console.log('✓ Matched existing doctor:', matchedDoctor.name);
                } else {
                  console.log('⚠ No matching doctor found for:', result.doctorInfo.name);
                  console.log('User will need to select doctor manually');
                }
              }
            }
          }

          // Auto-select matched tests (only tests with isSelected: true from AI)
          if (formData.selectedTestIds.length > 0) {
            setSelectedTests(formData.selectedTestIds);
            console.log(`✓ Auto-selected ${formData.selectedTestIds.length} tests from TRF checkboxes`);
          }

          // Set unmatched tests for manual review
          if (formData.unmatchedTests.length > 0) {
            setTrfUnmatchedTests(formData.unmatchedTests);
            console.log(`⚠ ${formData.unmatchedTests.length} tests need manual selection`);
          }

          // Set clinical notes
          if (formData.clinicalNotes) {
            setNotes(formData.clinicalNotes);
          }

          // Set priority/urgency
          if (formData.urgency) {
            setPriority(formData.urgency);
          }

        } else {
          alert(`Failed to process TRF: ${result.error}`);
        }
      } catch (error: any) {
        console.error('TRF processing error:', error);
        alert(`Error processing TRF: ${error.message}`);
      } finally {
        setProcessingTRF(false);
      }
    }
  };

  const handleToggleTest = (id: string) => {
    setSelectedTests((prev) => {
      const test = testGroups.find(t => t.id === id);
      const isSelecting = !prev.includes(id);

      let newTests = isSelecting ? [...prev, id] : prev.filter((x) => x !== id);

      // Package selection logic
      if (test?.type === 'package' && isSelecting) {
        // When selecting a package, remove any individual tests that are part of this package
        // to avoid double-charging
        const packageTestGroupIds = test.testGroupIds || [];
        newTests = newTests.filter(testId => {
          if (testId === id) return true; // Keep the package itself
          const t = testGroups.find(tg => tg.id === testId);
          return t?.type === 'package' || !packageTestGroupIds.includes(testId);
        });
      } else if (test?.type !== 'package' && isSelecting) {
        // When selecting an individual test, check if it's already in a selected package
        const selectedPackages = testGroups.filter(
          tg => tg.type === 'package' && prev.includes(tg.id)
        );
        const isInSelectedPackage = selectedPackages.some(
          pkg => pkg.testGroupIds?.includes(id)
        );
        if (isInSelectedPackage) {
          // Don't add this test - it's already included in a package
          return prev; // No change
        }
      }

      // When adding a test, check if it has default outsourced lab
      if (isSelecting && test) {
        if (test.is_outsourced && test.default_outsourced_lab_id) {
          setTestOutsourcingConfig(config => ({
            ...config,
            [id]: test.default_outsourced_lab_id!
          }));
        } else {
          // Default to in-house
          setTestOutsourcingConfig(config => ({
            ...config,
            [id]: 'inhouse'
          }));
        }
      } else if (!isSelecting) {
        // Remove outsourcing config when test is deselected
        setTestOutsourcingConfig(config => {
          const newConfig = { ...config };
          delete newConfig[id];
          return newConfig;
        });
      }

      return newTests;
    });

    // UX Improvement: Clear search & Refocus
    if (testSearch) {
      setTestSearch('');
    }
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
  };

  // Track whether the TRF attachment was successfully linked to a saved order
  const trfAttachmentLinked = React.useRef(false);

  // When form is closed without saving, delete any orphan TRF attachment
  const handleClose = async () => {
    if (trfExtraction?.attachmentId && !trfAttachmentLinked.current) {
      // Delete orphan attachment from storage + DB
      try {
        const { data: att } = await supabase
          .from('attachments')
          .select('file_path')
          .eq('id', trfExtraction.attachmentId)
          .single();
        if (att?.file_path) {
          await supabase.storage.from('attachments').remove([att.file_path]);
        }
        await supabase.from('attachments').delete().eq('id', trfExtraction.attachmentId);
        console.log('Cleaned up orphan TRF attachment:', trfExtraction.attachmentId);
      } catch (err) {
        console.warn('Failed to clean up orphan TRF attachment:', err);
      }
    }
    onClose();
  };

  const focusFirstField = () => {
    setTimeout(() => {
      patientInputRef.current?.focus();
      modalScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    }, 50);
  };

  const resetForNextOrder = () => {
    setSelectedPatient(null);
    setPatientSearch('');
    setSelectedTests([]);
    setTestSearch('');
    setShowTestList(false);
    setTestOutsourcingConfig({});
    setAdditionalInputs({});
    setSelectedBillingItems([]);
    setShowAddBillingItem(false);
    setNewBillingItemTypeId('');
    setNewBillingItemName('');
    setNewBillingItemAmount('');
    setDiscountType('percentage');
    setDiscountValue(0);
    setDiscountBy('lab');
    setPaymentMethod('cash');
    setAmountPaid(0);
    setTakeFullPayment(false);
    setLoyaltyPointsToRedeem(0);
    setLoyaltyRedeemEnabled(false);
    setNotes('');
    setClinicalNotesOpen(false);
    setPreBarcoded(false);
    setPreBarcode('');
    setOrderDetailsOpen(false);
    setPriority('Normal');
    setCustomOrderDate('');
    setCustomReportDate('');
    setTestRequestFile(null);
    setTrfExtraction(null);
    setTrfProgress(null);
    setShowTRFReview(false);
    setTrfUnmatchedTests([]);
    setValidationErrors([]);
    setSubmissionProgress('');
    trfAttachmentLinked.current = false;
    focusFirstField();
  };

  const finishSuccessfulSubmit = (message: string) => {
    const createNext = submitModeRef.current === 'new';

    setSubmissionProgress(message);
    setTimeout(() => {
      setIsSubmitting(false);
      if (createNext) {
        resetForNextOrder();
      } else {
        onClose();
      }
    }, 700);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const createNext = submitModeRef.current === 'new';

    // Clear previous errors
    setValidationErrors([]);
    const errors: string[] = [];
    let patientForOrder = selectedPatient;

    if (!patientForOrder?.id && initialBookingData?.patient_info?.name) {
      try {
        setIsSubmitting(true);
        setSubmissionProgress('Creating patient from booking...');
        const createdPatient = await createPatientFromBooking();
        if (createdPatient?.id) {
          patientForOrder = createdPatient;
        }
      } catch (err) {
        console.error('Failed to create patient from booking:', err);
        errors.push('❌ Patient: Failed to create patient from booking details');
      } finally {
        setIsSubmitting(false);
      }
    }

    // Comprehensive validation
    if (!patientForOrder?.id) {
      errors.push('❌ Patient: Please select a patient');
    }

    // Doctor is optional — 'SELF' means self-referred / walk-in

    if (selectedTests.length === 0 && selectedBillingItems.length === 0) {
      errors.push('❌ Tests or Billing Items: Please select at least one test or add a billing item');
    }

    if (
      (paymentType === 'credit' || paymentType === 'corporate' || paymentType === 'insurance') &&
      !selectedAccount &&
      !selectedLocation
    ) {
      errors.push('❌ Payment: For non-self payments, choose a Bill-to Account or Location');
    }

    if (creditInfo && !creditInfo.allowed) {
      errors.push(
        `❌ Credit Limit: ${creditInfo.kind === 'account' ? 'Account' : 'Location'} credit limit exceeded. Available: ₹${creditInfo.availableCredit}`
      );
    }

    // Block orders against a locked (on-hold) account. Only an admin can open it
    // in Account Master; there is no override here.
    if (selectedAccount) {
      const lockedAccount = accounts.find(a => a.id === selectedAccount);
      if (isAccountEffectivelyLocked(lockedAccount)) {
        errors.push(
          `❌ Account Locked: "${lockedAccount?.name || 'This account'}" is locked and cannot be used for new orders. An admin must open it in Account Master.`
        );
      }
    }

    if (!patientForOrder) {
      errors.push('❌ Patient is required');
    }

    // Validate Required Inputs
    requiredInfos.forEach(info => {
      if (!additionalInputs[info]) {
        errors.push(`❌ Missing required information: ${info.replace(/_/g, ' ')}`);
      }
    });

    if (preBarcoded) {
      const cleanBarcode = preBarcode.trim();
      const selectedTestDetailsForBarcode = testGroups.filter((t) => selectedTests.includes(t.id));
      const uniqueSampleTypes = Array.from(new Set(
        selectedTestDetailsForBarcode.map((test) => test.sampleType || test.sample_type || 'Blood')
      ));

      if (!/^\d{10,12}$/.test(cleanBarcode)) {
        errors.push('Pre-barcoded Sample: Barcode must be numeric and 10 to 12 digits');
      }

      if (uniqueSampleTypes.length > 1) {
        errors.push('Pre-barcoded Sample: Manual barcode is supported only when selected tests need one sample type');
      }

      if (/^\d{10,12}$/.test(cleanBarcode)) {
        const labId = await database.getCurrentUserLabId();
        if (labId) {
          const { data: existingBarcode, error: barcodeCheckError } = await supabase
            .from('samples')
            .select('id')
            .eq('lab_id', labId)
            .eq('barcode', cleanBarcode)
            .maybeSingle();

          if (barcodeCheckError) {
            errors.push(`Pre-barcoded Sample: Could not validate barcode uniqueness (${barcodeCheckError.message})`);
          } else if (existingBarcode?.id) {
            errors.push('Pre-barcoded Sample: This barcode is already used in this lab');
          }
        }
      }
    }

    // If validation fails, show errors and stop
    if (errors.length > 0) {
      setValidationErrors(errors);
      // Scroll to top to show errors
      document.querySelector('.overflow-y-auto')?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    // Start submission with loading state
    setIsSubmitting(true);
    setSubmissionProgress('Preparing order data...');

    try {
      // Build selected tests payload (if any)
      setSubmissionProgress('Processing test selections...');
      const selectedTestDetails = testGroups.filter((t) => selectedTests.includes(t.id));

      const testsPayload =
        selectedTestDetails.length > 0
          ? selectedTestDetails.map((t) => {
            const outsourcedLabId = testOutsourcingConfig[t.id] === 'inhouse' ? null : testOutsourcingConfig[t.id] || null;
            const { price: finalPrice, labReceivable } = resolvePrice(t.id, t.price);
            return {
              id: t.id,
              name: t.name,
              type: t.type ?? 'test',
              price: finalPrice,
              outsourced_lab_id: outsourcedLabId,
              location_receivable: labReceivable // Track what lab receives from location
            };
          })
          : undefined;

      // Compose order payload (account layer included)
      setSubmissionProgress('Creating order record...');

      // Calculate total from selected tests (respects package prices, account prices, and location prices)
      const calculatedTotal = selectedTestDetails.reduce((sum, t) => {
        const { price } = resolvePrice(t.id, t.price);
        return sum + price;
      }, 0);

      // Store date-only expected date at creation (TAT clock starts after sample receipt, not registration)
      const orderDateObj = customOrderDate ? new Date(customOrderDate) : new Date();
      const computedExpectedDate = orderDateObj.toISOString().split('T')[0];

      const orderData: any = {
        patient_id: patientForOrder!.id,
        patient_name: patientForOrder!.name,
        referring_doctor_id: (selectedDoctor && selectedDoctor !== SELF_DOCTOR_ID) ? selectedDoctor : null,
        location_id: selectedLocation || null, // collection/origin
        collected_at_location_id: selectedLocation || null, // for intra-lab transit tracking
        account_id: selectedAccount || null, // B2B bill-to
        payment_type: paymentType,
        priority,
        expected_date: computedExpectedDate,
        doctor: (selectedDoctor && selectedDoctor !== SELF_DOCTOR_ID) ? (doctors.find((d) => d.id === selectedDoctor)?.name || 'Self') : 'Self',
        notes: notes || null,
        __createAndNew: createNext,
        __preBarcoded: preBarcoded,
        __preBarcodedBarcode: preBarcoded ? preBarcode.trim() : null,
        total_amount: calculatedTotal + collectionCharge, // Tests + collection only; extra charges tracked separately in order_billing_items
        collection_charge: collectionCharge > 0 ? collectionCharge : null,
        final_amount: finalAmount, // Total after discount
        ...(isAdmin && customOrderDate ? {
          created_at: new Date(customOrderDate).toISOString(),
          order_date: new Date(customOrderDate).toISOString().split('T')[0]
        } : {}),
        ...(isAdmin && customReportDate ? {
          report_date: customReportDate
        } : {}),
        // AI Patient Context
        patient_context: {
          age: patientForOrder!.age,
          age_unit: patientForOrder!.age_unit || 'years',
          gender: patientForOrder!.gender,
          weight: additionalInputs.weight,
          height: additionalInputs.height,
          pregnancy_status: additionalInputs.pregnancy_status,
          lmp: additionalInputs.lmp,
          date_of_birth: patientForOrder!.dob || patientForOrder!.date_of_birth || null,
          additional_inputs: additionalInputs, // Catch-all
          // Custom patient fields marked for AI ref range context (e.g. species, breed)
          ...(() => {
            const aiFields = allPatientFieldConfigs.filter(f => f.use_for_ai_ref_range);
            if (aiFields.length === 0) return {};
            const cf = (patientForOrder as any).custom_fields;
            const parsed = typeof cf === 'string' ? (() => { try { return JSON.parse(cf); } catch { return {}; } })() : (cf || {});
            const custom_patient_data: Record<string, any> = {};
            for (const f of aiFields) {
              if (parsed[f.field_key] !== undefined && parsed[f.field_key] !== '') {
                custom_patient_data[f.label] = parsed[f.field_key];
              }
            }
            return Object.keys(custom_patient_data).length > 0 ? { custom_patient_data } : {};
          })()
        }
      };

      // Auto-collect: mark sample as collected at registration time
      if (autoCollectOnRegistration) {
        const { data: { user: currentUser } } = await supabase.auth.getUser();
        const collectorName = currentUser?.user_metadata?.name || currentUser?.email || 'Reception';
        orderData.sample_collected_at = new Date().toISOString();
        orderData.sample_collected_by = collectorName;
        orderData.sample_collector_id = currentUser?.id || null;
      }

      if (testsPayload) orderData.tests = testsPayload;
      if (testRequestFile) orderData.testRequestFile = testRequestFile;
      // Pass TRF attachment ID so Orders.tsx links only this specific attachment
      if (trfExtraction?.attachmentId) orderData.trfAttachmentId = trfExtraction.attachmentId;

      // Include loyalty redemption data in order
      if (loyaltyRedeemEnabled && loyaltyPointsToRedeem > 0) {
        orderData.loyalty_points_redeemed = loyaltyPointsToRedeem;
        orderData.loyalty_discount_amount = loyaltyDiscountAmount;
      }

      setSubmissionProgress('Saving order...');
      const result = await onSubmit(orderData);
      // Mark TRF attachment as linked so handleClose won't delete it
      trfAttachmentLinked.current = true;

      // Auto-print every generated barcode label if enabled.
      const newOrderId = result?.id || result;
      if (newOrderId) {
        supabase
          .from('samples')
          .select('id, barcode, sample_type, created_at')
          .eq('order_id', newOrderId)
          .then(({ data: createdSamples }) => {
            if (!createdSamples || createdSamples.length === 0) return;

            autoPrintBarcodes(createdSamples.map((sample: any) => {
              const collectionDate = sample.created_at ? new Date(sample.created_at) : new Date();
              return {
                sampleId: sample.barcode || sample.id,
                labelId: sample.id,
                patientName: patientForOrder?.name || '',
                sampleType: sample.sample_type || undefined,
                date: collectionDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-'),
                collectionTime: collectionDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
                gender: patientForOrder?.gender || undefined,
                age: patientForOrder?.age ? String(patientForOrder.age) : undefined,
                referredBy: selectedDoctor === SELF_DOCTOR_ID ? undefined : doctorSearch,
              };
            }));
          })
          .catch(() => {});

        // Notify parent to auto-open collection modal (setting: auto_open_collection_modal).
        // Fast-entry mode intentionally skips this so accession collects manually later.
        console.debug('[AutoCollect] onOrderCreated prop present?', !!onOrderCreated, '| newOrderId:', newOrderId);
        if (onOrderCreated && !createNext) {
          onOrderCreated(newOrderId);
        }
      }

      // Auto-create invoice and payment if discount or payment is provided
      if (discountValue > 0 || amountPaid > 0) {
        try {
          setSubmissionProgress('Creating invoice and payment...');

          // Get order ID from result - it's the full order object with {id, ...}
          const orderId = result?.id || result;

          if (!orderId) {
            console.error('No order ID returned from order creation. Result:', result);
            throw new Error('Order created but ID not available');
          }

          // ✅ OPTIMIZED: Get labId and authUser ONCE at the start (was called 2-3 times)
          const [labId, authUserResult] = await Promise.all([
            database.getCurrentUserLabId(),
            supabase.auth.getUser()
          ]);
          const authUser = authUserResult.data;

          console.log('📝 Creating invoice for order:', orderId);

          // Subtotal including collection charge + extra charges for invoice accuracy
          const invoiceSubtotal = calculatedTotal + collectionCharge + extraChargesTotal;

          // Create invoice
          const invoiceData = {
            order_id: orderId,
            patient_id: patientForOrder!.id,
            patient_name: patientForOrder!.name,
            lab_id: labId,
            subtotal: invoiceSubtotal,
            total_before_discount: invoiceSubtotal,
            collection_charge: collectionCharge > 0 ? collectionCharge : null,
            discount: discountAmount,
            total_discount: discountAmount,
            total_after_discount: finalAmount,
            total: finalAmount,
            // Online collection hasn't happened yet — the gateway webhook writes
            // the payments row and flips the invoice once the patient actually pays.
            amount_paid: isOnlineCollection ? 0 : amountPaid,
            tax: 0,
            due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
            status: isOnlineCollection
              ? 'Draft'
              : (amountPaid >= finalAmount ? 'Paid' : (amountPaid > 0 ? 'Partial' : 'Draft')),
            ...(discountAmount > 0 ? { discount_source: discountBy } : {}),
          };

          // ✅ OPTIMIZED: Run invoice creation and order update in parallel
          const [invoiceResult, orderUpdateResult] = await Promise.all([
            supabase.from('invoices').insert(invoiceData).select().single(),
            supabase.from('orders').update({ billing_status: 'billed', is_billed: true }).eq('id', orderId)
          ]);

          if (invoiceResult.error) {
            console.error('Invoice creation failed:', invoiceResult.error);
            throw invoiceResult.error;
          }

          const invoice = invoiceResult.data;
          console.log('✅ Invoice created:', invoice.id);

          if (orderUpdateResult.error) {
            console.error('Failed to update order billing status:', orderUpdateResult.error);
          }

          // ✅ FIX: Fetch the actual order_tests to get their IDs for proper invoice linking
          // This prevents duplicate billing when CreateInvoiceModal is opened later
          let orderTestsData = result?.order_tests;
          if (!orderTestsData?.length) {
            const orderTestsResult = await supabase
              .from('order_tests')
              .select('id, test_name, test_group_id, price, outsourced_lab_id')
              .eq('order_id', orderId);
            orderTestsData = orderTestsResult.data;
          }

          // Create a map of test_group_id/test_name to order_test record for matching
          const orderTestsMap = new Map<string, any>();
          (orderTestsData || []).forEach(ot => {
            // Map by test_group_id first (more reliable), then by name as fallback
            if (ot.test_group_id) {
              orderTestsMap.set(ot.test_group_id, ot);
            }
            orderTestsMap.set(ot.test_name, ot);
          });

          // Create invoice items with proper order_test_id linkage
          const invoiceItemsData = await Promise.all(selectedTestDetails.map(async t => {
            const { price, labReceivable } = resolvePrice(t.id, t.price);
            const outsourcedLabId = testOutsourcingConfig[t.id] === 'inhouse' ? null : testOutsourcingConfig[t.id] || null;
            
            // Find matching order_test record
            const orderTest = orderTestsMap.get(t.id) || orderTestsMap.get(t.name);
            
            // Fetch outsourced cost if applicable
            let outsourcedCost: number | null = null;
            if (outsourcedLabId) {
              const { data: costData } = await database.outsourcedLabPrices.getCost(outsourcedLabId, t.id);
              outsourcedCost = costData?.cost || null;
            }
            
            return {
              invoice_id: invoice.id,
              order_test_id: orderTest?.id || null, // ✅ Link to actual order_test record
              test_name: t.name,
              price: price,
              quantity: 1,
              total: price,
              lab_id: labId,
              order_id: orderId,
              location_receivable: labReceivable || null,
              outsourced_lab_id: outsourcedLabId || null,
              outsourced_cost: outsourcedCost
            };
          }));

          // Add collection charge as a separate invoice line item if applicable
          if (collectionCharge > 0) {
            invoiceItemsData.push({
              invoice_id: invoice.id,
              order_test_id: null,
              test_name: 'Sample Collection Charge',
              price: collectionCharge,
              quantity: 1,
              total: collectionCharge,
              lab_id: labId,
              order_id: orderId,
              location_receivable: null,
              outsourced_lab_id: null,
              outsourced_cost: null
            } as any);
          }

          // Insert extra lab billing items as order_billing_items + invoice_items
          // Each billing item is inserted individually so we can write invoice_item_id
          // back to order_billing_items immediately — prevents orphaned billing items
          // where is_invoiced=true but no invoice_item row exists.
          if (selectedBillingItems.length > 0) {
            for (const item of selectedBillingItems) {
              const { data: obi, error: obiError } = await supabase.from('order_billing_items').insert({
                lab_id: labId,
                order_id: orderId,
                lab_billing_item_type_id: item.typeId || null,
                name: item.name,
                amount: item.amount,
                is_shareable_with_doctor: item.is_shareable_with_doctor,
                is_shareable_with_phlebotomist: item.is_shareable_with_phlebotomist,
                is_invoiced: true,
              }).select('id').single();

              if (obiError || !obi?.id) {
                console.error('Error creating order_billing_item:', obiError);
                continue;
              }

              // Insert invoice_item immediately and write back invoice_item_id
              const { data: invoiceItem, error: iiError } = await supabase.from('invoice_items').insert({
                invoice_id: invoice.id,
                order_billing_item_id: obi.id,
                order_test_id: null,
                test_name: item.name,
                price: item.amount,
                quantity: 1,
                total: item.amount,
                item_type: 'lab_charge',
                is_shareable_with_doctor: item.is_shareable_with_doctor,
                is_shareable_with_phlebotomist: item.is_shareable_with_phlebotomist,
                lab_id: labId,
                order_id: orderId,
                location_receivable: null,
                outsourced_lab_id: null,
                outsourced_cost: null,
              } as any).select('id').single();

              if (iiError) {
                console.error('Error creating invoice_item for billing charge:', iiError);
              } else if (invoiceItem?.id) {
                // Link invoice_item back to order_billing_items
                await supabase.from('order_billing_items')
                  .update({ invoice_item_id: invoiceItem.id, updated_at: new Date().toISOString() })
                  .eq('id', obi.id);
              }
            }
          }

          // ✅ OPTIMIZED: Run invoice items and payment creation in parallel if applicable
          const parallelOps: Promise<any>[] = [];

          if (invoiceItemsData.length > 0) {
            parallelOps.push(
              (async () => {
                const res = await supabase.from('invoice_items').insert(invoiceItemsData);
                if (res.error) {
                  console.error('Error creating invoice items:', res.error);
                  throw res.error;
                }
                console.log(`✅ Added ${invoiceItemsData.length} invoice items`);
                return res;
              })()
            );

            // ✅ FIX: Mark order_tests as billed to prevent duplicate invoicing
            // Collect all order_test_ids that were billed
            const billedOrderTestIds = invoiceItemsData
              .filter(item => item.order_test_id)
              .map(item => item.order_test_id);

            if (billedOrderTestIds.length > 0) {
              parallelOps.push(
                (async () => {
                  const { error: updateError } = await supabase
                    .from('order_tests')
                    .update({ 
                      is_billed: true, 
                      invoice_id: invoice.id,
                      billed_at: new Date().toISOString()
                    })
                    .in('id', billedOrderTestIds);
                  
                  if (updateError) {
                    console.error('Error marking order_tests as billed:', updateError);
                  } else {
                    console.log(`✅ Marked ${billedOrderTestIds.length} order_tests as billed`);
                  }
                })()
              );
            }
          }

          if (amountPaid > 0 && invoice && !isOnlineCollection) {
            const paymentData = {
              invoice_id: invoice.id,
              amount: amountPaid,
              payment_method: paymentMethod,
              received_by: authUser.user?.id,
              lab_id: labId,
              location_id: selectedLocation || null,
              payment_reference: `PAY-${Date.now()}`,
            };

            parallelOps.push(
              (async () => {
                const res = await supabase.from('payments').insert(paymentData).select().single();
                if (res.error) {
                  console.error('Payment creation failed:', res.error);
                  throw res.error;
                }
                console.log('✅ Payment created:', res.data.id);
                return res;
              })()
            );
          }

          // Wait for all parallel operations
          if (parallelOps.length > 0) {
            await Promise.all(parallelOps);
          }

          // Handle loyalty points: redeem & earn
          if (loyaltyEnabled && patientForOrder?.id && orderId) {
            try {
              // Redeem points if used
              if (loyaltyRedeemEnabled && loyaltyPointsToRedeem > 0) {
                setSubmissionProgress('Redeeming loyalty points...');
                await database.loyaltyPoints.redeemPoints(patientForOrder.id, orderId, loyaltyPointsToRedeem);
                console.log(`✅ Redeemed ${loyaltyPointsToRedeem} loyalty points`);
              }

              // Earn points on the paid amount (excluding loyalty discount)
              if (amountPaid > 0) {
                setSubmissionProgress('Awarding loyalty points...');
                await database.loyaltyPoints.earnPoints(patientForOrder.id, orderId, amountPaid);
                console.log(`✅ Earned loyalty points on ${currencySymbol}${amountPaid} payment`);
              }
            } catch (loyaltyErr) {
              console.error('Loyalty points processing error (non-critical):', loyaltyErr);
            }
          }

          if (isOnlineCollection) {
            // Hold the form open on a QR panel so the counter can collect now.
            setSubmissionProgress('');
            setIsSubmitting(false);
            setOnlineCollection({
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoice_number || null,
              labId: labId as string,
              patientId: patientForOrder!.id,
              patientName: patientForOrder!.name,
              patientPhone: (patientForOrder as any)?.phone || undefined,
              amount: amountPaid,
            });
          } else {
            finishSuccessfulSubmit('Order, invoice, and payment created successfully!');
          }
        } catch (err: any) {
          console.error('Post-order creation error:', err);
          alert(`Order created but failed to create invoice/payment: ${err.message}`);
          if (createNext) {
            setIsSubmitting(false);
            resetForNextOrder();
          } else {
            onClose();
          }
        }
      } else {
        // No invoice created — save billing items as order_billing_items only
        const orderId = result?.id || result;
        if (orderId && selectedBillingItems.length > 0) {
          const labId = await database.getCurrentUserLabId();
          for (const item of selectedBillingItems) {
            await supabase.from('order_billing_items').insert({
              lab_id: labId,
              order_id: orderId,
              lab_billing_item_type_id: item.typeId || null,
              name: item.name,
              amount: item.amount,
              is_shareable_with_doctor: item.is_shareable_with_doctor,
              is_shareable_with_phlebotomist: item.is_shareable_with_phlebotomist,
              is_invoiced: false,
            });
          }
        }
        // No invoice created, but still handle loyalty redemption if applicable
        if (loyaltyEnabled && patientForOrder?.id && orderId && loyaltyRedeemEnabled && loyaltyPointsToRedeem > 0) {
          try {
            setSubmissionProgress('Redeeming loyalty points...');
            await database.loyaltyPoints.redeemPoints(patientForOrder.id, orderId, loyaltyPointsToRedeem);
            console.log(`✅ Redeemed ${loyaltyPointsToRedeem} loyalty points (no invoice)`);
          } catch (loyaltyErr) {
            console.error('Loyalty points redemption error (non-critical):', loyaltyErr);
          }
        }
        finishSuccessfulSubmit('Order created successfully!');
      }

      // OrderForm will be unmounted by onClose
    } catch (error: any) {
      console.error('Order submission error:', error);
      setValidationErrors([`❌ Submission Failed: ${error.message || 'Unknown error occurred'}`]);
      setIsSubmitting(false);
      setSubmissionProgress('');
    }
  };

  // Quick-Add Doctor handler
  const handleAddDoctor = async () => {
    if (!newDoctorData.name.trim()) return;
    setAddingDoctor(true);
    try {
      const result = await database.doctors.create({
        name: newDoctorData.name.trim(),
        specialization: newDoctorData.specialization || undefined,
        phone: newDoctorData.phone || undefined,
        hospital: newDoctorData.hospital || undefined,
        is_referring_doctor: true,
      });
      if (result.data) {
        const { data: refreshed } = await database.doctors.getAll();
        if (refreshed) setDoctors(refreshed as any);
        setSelectedDoctor(result.data.id);
        setDoctorSearch(result.data.name);
        setShowAddDoctorModal(false);
        setNewDoctorData({ name: '', specialization: '', phone: '', hospital: '' });
      } else {
        alert('Failed to add doctor. Please try again.');
      }
    } catch (e) {
      console.error('Error adding doctor:', e);
      alert('Error adding doctor.');
    } finally {
      setAddingDoctor(false);
    }
  };

  // Totals (for UI display only)
  const selectedTestRows = testGroups.filter((t) => selectedTests.includes(t.id));
  const totalAmount = selectedTestRows.reduce((sum, t) => {
    const { price } = resolvePrice(t.id, t.price);
    return sum + price;
  }, 0);

  // Load lab billing item types on mount
  React.useEffect(() => {
    database.getCurrentUserLabId().then(labId => {
      if (!labId) return;
      supabase
        .from('lab_billing_item_types')
        .select('id, name, default_amount, is_shareable_with_doctor, is_shareable_with_phlebotomist')
        .eq('lab_id', labId)
        .eq('is_active', true)
        .order('name')
        .then(({ data }) => setBillingItemTypes(data || []));
    });
  }, []);

  // Auto-update collection charge from selected test groups
  React.useEffect(() => {
    const autoCharge = selectedTestRows.reduce((sum, t) => sum + (t.collection_charge || 0), 0);
    setCollectionCharge(autoCharge);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTests.join(',')]);

  // Calculate discount
  const discountAmount = discountValue > 0
    ? (discountType === 'percentage' ? ((totalAmount + collectionCharge + extraChargesTotal) * discountValue) / 100 : Math.min(discountValue, totalAmount + collectionCharge + extraChargesTotal))
    : 0;
  const loyaltyDiscountAmount = loyaltyRedeemEnabled && loyaltyPointsToRedeem > 0
    ? loyaltyPointsToRedeem * loyaltyPointValue
    : 0;
  const finalAmount = Math.max(0, totalAmount + collectionCharge + extraChargesTotal - discountAmount - loyaltyDiscountAmount);
  const balanceDue = finalAmount - amountPaid;
  const isMonthlyBillingAccount = !!(selectedAccount && accounts.find(a => a.id === selectedAccount)?.billing_mode === 'monthly');

  useEffect(() => {
    if (!takeFullPayment) return;
    const payableAmount = Math.max(0, Number(finalAmount) || 0);
    setAmountPaid(Number(payableAmount.toFixed(2)));
  }, [takeFullPayment, finalAmount]);

  // Fetch loyalty balance when patient is selected
  useEffect(() => {
    const fetchLoyalty = async () => {
      if (!selectedPatient?.id) {
        setLoyaltyEnabled(false);
        setLoyaltyBalance(0);
        setLoyaltyPointsToRedeem(0);
        setLoyaltyRedeemEnabled(false);
        return;
      }
      try {
        const settings = await database.loyaltyPoints.getLabSettings();
        if (settings?.loyalty_enabled) {
          setLoyaltyEnabled(true);
          setLoyaltyMinRedeem(settings.loyalty_min_redeem_points ?? 100);
          setLoyaltyPointValue(settings.loyalty_point_value ?? 1.0);
          const balance = await database.loyaltyPoints.getBalance(selectedPatient.id);
          setLoyaltyBalance(balance.current_balance);
        } else {
          setLoyaltyEnabled(false);
        }
      } catch (err) {
        console.error('Error fetching loyalty info:', err);
        setLoyaltyEnabled(false);
      }
    };
    fetchLoyalty();
  }, [selectedPatient?.id]);

  // Auto-focus patient search on mount
  useEffect(() => {
    setTimeout(() => patientInputRef.current?.focus(), 100);
  }, []);

  // Focus trap for Add New Patient modal
  useEffect(() => {
    if (!showNewPatientModal) return;
    const modal = newPatientModalRef.current;
    if (!modal) return;

    const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Focus first field on open
    const first = modal.querySelector<HTMLElement>(FOCUSABLE);
    setTimeout(() => first?.focus(), 50);

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      } else {
        if (document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };

    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [showNewPatientModal]);

  // Alt+P: open Add Patient modal when no patient selected
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.altKey && e.key.toLowerCase() === 'p' && !selectedPatient) {
        e.preventDefault();
        npResetNameFields();
        setNewPatient({ name: '', age: '', age_unit: 'years', gender: 'Male', phone: '', email: '', dob: '' });
        setShowNewPatientModal(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedPatient]);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onKeyDown={(e) => {
        const scrollable = modalScrollRef.current;
        if (!scrollable) return;
        const active = document.activeElement as HTMLElement | null;
        // Only intercept if no input/select/textarea is focused (let them handle their own keys)
        const isInputFocused = active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
        if (isInputFocused) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); scrollable.scrollBy({ top: 80, behavior: 'smooth' }); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); scrollable.scrollBy({ top: -80, behavior: 'smooth' }); }
        else if (e.key === 'PageDown') { e.preventDefault(); scrollable.scrollBy({ top: scrollable.clientHeight * 0.8, behavior: 'smooth' }); }
        else if (e.key === 'PageUp') { e.preventDefault(); scrollable.scrollBy({ top: -scrollable.clientHeight * 0.8, behavior: 'smooth' }); }
        else if (e.key === 'End') { e.preventDefault(); scrollable.scrollTo({ top: scrollable.scrollHeight, behavior: 'smooth' }); }
        else if (e.key === 'Home') { e.preventDefault(); scrollable.scrollTo({ top: 0, behavior: 'smooth' }); }
      }}
    >
      <div ref={modalScrollRef} className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Create New Order</h2>
          <button onClick={handleClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-8">
          {/* Validation Errors Display */}
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-red-800 font-semibold">
                <AlertCircle className="h-5 w-5" />
                <span>Please fix the following errors:</span>
              </div>
              <ul className="space-y-1 ml-7">
                {validationErrors.map((error, idx) => (
                  <li key={idx} className="text-sm text-red-700">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Loading Overlay */}
          {isSubmitting && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader className="h-5 w-5 text-blue-600 animate-spin" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-blue-900">Creating Order...</div>
                  <div className="text-xs text-blue-700 mt-1">{submissionProgress}</div>
                </div>
              </div>
              <div className="mt-3 h-2 bg-blue-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 animate-pulse" style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {/* ── Validation Errors ── */}
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2 text-red-800 font-semibold">
                <AlertCircle className="h-5 w-5" />
                <span>Please fix the following errors:</span>
              </div>
              <ul className="space-y-1 ml-7">
                {validationErrors.map((error, idx) => (
                  <li key={idx} className="text-sm text-red-700">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Submitting overlay ── */}
          {isSubmitting && (
            <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
              <div className="flex items-center gap-3">
                <Loader className="h-5 w-5 text-blue-600 animate-spin" />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-blue-900">Creating Order...</div>
                  <div className="text-xs text-blue-700 mt-1">{submissionProgress}</div>
                </div>
              </div>
              <div className="mt-3 h-2 bg-blue-200 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 animate-pulse" style={{ width: '100%' }} />
              </div>
            </div>
          )}

          {/* ── Patient + Add + AI Upload — compact top row ── */}
          <section className="space-y-2">
            {/* Hidden file input for AI TRF - gallery/file picker */}
            <input
              type="file"
              id="trf-upload-top"
              accept="image/*,.pdf"
              onChange={handleFileChange}
              className="hidden"
            />
            {/* Hidden file input for AI TRF - camera capture (mobile) */}
            <input
              type="file"
              id="trf-camera-capture"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />

            {selectedPatient ? (
              /* Selected chip */
              <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm">
                <User className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                <span className="font-medium text-blue-900">{selectedPatient.name}</span>
                <span className="text-blue-600 text-xs">
                  {formatAge(selectedPatient.age, selectedPatient.age_unit)}, {selectedPatient.gender ?? '-'}
                  {selectedPatient.phone ? ` · ${selectedPatient.phone}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedPatient(null); setPatientSearch(''); setTimeout(() => patientInputRef.current?.focus(), 50); }}
                  className="ml-auto flex items-center gap-1 text-xs text-blue-500 hover:text-red-600 transition-colors px-2 py-0.5 rounded hover:bg-red-50"
                >
                  <X className="w-3 h-3" /> Change
                </button>
              </div>
            ) : (
              /* Search row: [patient search] [Add Patient] [AI TRF] */
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-gray-400 absolute left-2 top-2.5 pointer-events-none z-10" />
                  <input
                    ref={patientInputRef}
                    type="text"
                    value={patientSearch}
                    onChange={(e) => { setPatientSearch(e.target.value); setHighlightedPatientIndex(-1); setShowPatientDropdown(true); }}
                    onFocus={() => setShowPatientDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setHighlightedPatientIndex(i => Math.min(i + 1, filteredPatients.length - 1));
                        setShowPatientDropdown(true);
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setHighlightedPatientIndex(i => Math.max(i - 1, 0));
                      } else if ((e.key === 'Enter' || e.key === ' ') && (highlightedPatientIndex >= 0 || filteredPatients.length === 1)) {
                        e.preventDefault();
                        const idx = highlightedPatientIndex >= 0 ? highlightedPatientIndex : 0;
                        onPickPatient(filteredPatients[idx]);
                        setHighlightedPatientIndex(-1);
                      } else if (e.key === 'Tab') {
                        if (highlightedPatientIndex >= 0 || filteredPatients.length === 1) {
                          e.preventDefault();
                          const idx = highlightedPatientIndex >= 0 ? highlightedPatientIndex : 0;
                          onPickPatient(filteredPatients[idx]);
                          setHighlightedPatientIndex(-1);
                        } else {
                          setShowPatientDropdown(false);
                          searchInputRef.current?.focus();
                        }
                      } else if (e.key === 'Escape') {
                        setShowPatientDropdown(false);
                        setHighlightedPatientIndex(-1);
                      }
                    }}
                    onBlur={() => setTimeout(() => { setShowPatientDropdown(false); setHighlightedPatientIndex(-1); }, 200)}
                    placeholder="Search patient by name, phone, or ID…"
                    className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showPatientDropdown && filteredPatients.length > 0 && (
                    <div className="absolute z-[100] w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-2xl max-h-64 overflow-y-auto">
                      {filteredPatients.map((p, idx) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { onPickPatient(p); setHighlightedPatientIndex(-1); }}
                          className={`w-full px-4 py-3 text-left border-b border-gray-100 last:border-b-0 transition-colors ${
                            idx === highlightedPatientIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                          }`}
                        >
                          <div className="font-semibold text-gray-900 text-sm">{p.name}</div>
                          <div className="text-xs text-gray-600 mt-0.5">
                            {formatAge(p.age, p.age_unit)}, {p.gender ?? '-'} • {p.phone ?? '-'} • ID: {p.id.slice(-8)}
                            {searchablePatientFields.map(field => {
                              const val = (p as any).custom_fields?.[field.field_key];
                              return val ? <span key={field.field_key}> • {field.label}: {val}</span> : null;
                            })}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Add Patient */}
                <button
                  type="button"
                  onClick={() => { npResetNameFields(); setNewPatient({ name: '', age: '', age_unit: 'years', gender: 'Male', phone: '', email: '', dob: '' }); setShowNewPatientModal(true); }}
                  className="px-3 py-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap flex items-center gap-1"
                  title="Add new patient (Alt+P)"
                >
                  <Plus className="h-4 w-4" /> Add
                </button>

                {/* AI TRF Upload — compact */}
                {processingTRF ? (
                  <div className="flex items-center gap-1.5 px-3 py-2 bg-purple-50 border border-purple-200 rounded-md text-xs text-purple-700 whitespace-nowrap">
                    <Loader className="w-3.5 h-3.5 animate-spin" />
                    {trfProgress?.stage ?? 'Processing…'}
                    {trfProgress?.progress !== undefined && ` ${Math.round(trfProgress.progress)}%`}
                  </div>
                ) : trfExtraction?.success ? (
                  <button
                    type="button"
                    onClick={() => setShowTRFReview(true)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-green-50 border border-green-200 rounded-md text-xs text-green-700 hover:bg-green-100 whitespace-nowrap"
                  >
                    <CheckCircle className="w-3.5 h-3.5" /> Review TRF
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    {/* Camera capture for mobile */}
                    <label
                      htmlFor="trf-camera-capture"
                      className="flex items-center gap-1 px-2 py-2 bg-purple-50 border border-purple-200 rounded-l-md text-xs text-purple-700 hover:bg-purple-100 cursor-pointer whitespace-nowrap"
                      title="Capture TRF with camera"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </label>
                    {/* File/gallery upload */}
                    <label
                      htmlFor="trf-upload-top"
                      className="flex items-center gap-1.5 px-2 py-2 bg-purple-50 border border-purple-200 border-l-0 rounded-r-md text-xs text-purple-700 hover:bg-purple-100 cursor-pointer whitespace-nowrap"
                      title="Upload TRF from gallery or files"
                    >
                      <Sparkles className="w-3.5 h-3.5" /> AI TRF
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* TRF unmatched tests warning */}
            {trfUnmatchedTests.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg px-3 py-2 flex items-start gap-2 text-xs">
                <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
                <span className="text-yellow-800">
                  <strong>{trfUnmatchedTests.length} tests need manual selection:</strong> {trfUnmatchedTests.join(', ')}
                </span>
              </div>
            )}
          </section>

          {/* Test Selection */}
          <section className="space-y-3">
            <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
              <TestTube className="h-5 w-5" />
              Test Selection
              {selectedTests.length > 0 && (
                <span className="text-sm font-semibold text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full leading-none">
                  {selectedTests.length}
                </span>
              )}
            </h3>

            {loadingTests ? (
              <div className="p-4 text-center text-gray-500">Loading tests…</div>
            ) : (
              <div className="space-y-2">
                {/* Chip input box — selected tests as pills + search inside */}
                <div
                  className="border border-gray-300 rounded-md focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500
                             bg-white min-h-[42px] max-h-28 overflow-y-auto px-2 py-1.5 flex flex-wrap gap-1.5 items-center cursor-text"
                  onClick={e => {
                    const input = (e.currentTarget as HTMLElement).querySelector('input');
                    input?.focus();
                  }}
                >
                  {selectedTests.map(id => {
                    const t = testGroups.find(tg => tg.id === id);
                    if (!t) return null;
                    return (
                      <span
                        key={id}
                        className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${
                          t.type === 'package'
                            ? 'bg-purple-50 text-purple-700 border-purple-200'
                            : 'bg-blue-50 text-blue-700 border-blue-200'
                        }`}
                      >
                        {t.name}
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); handleToggleTest(id); }}
                          className="opacity-60 hover:opacity-100 leading-none"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    );
                  })}
                  <div className="relative flex-1 min-w-[180px] flex items-center">
                    <Search className="w-3.5 h-3.5 text-gray-400 absolute left-1.5 pointer-events-none" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={testSearch}
                      placeholder={selectedTests.length === 0 ? 'Search tests or packages…' : 'Add more…'}
                      onChange={(e) => {
                        setTestSearch(e.target.value);
                        setShowTestList(true);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && testSearch) {
                          e.preventDefault();
                          const search = testSearch.toLowerCase();
                          const match = testGroups.find(t =>
                            t.name.toLowerCase().includes(search) ||
                            (t.category && t.category.toLowerCase().includes(search)) ||
                            (t.code && t.code.toLowerCase().includes(search)) ||
                            (t.type === 'package' && 'package'.includes(search))
                          );
                          if (match) handleToggleTest(match.id);
                        } else if (e.key === 'Backspace' && !testSearch && selectedTests.length > 0) {
                          handleToggleTest(selectedTests[selectedTests.length - 1]);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setShowTestList(false);
                          setTestSearch('');
                          setTimeout(() => doctorInputRef.current?.focus(), 50);
                        }
                      }}
                      onFocus={(e) => { setShowTestList(true); e.currentTarget.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }}
                      className="w-full pl-6 text-sm outline-none bg-transparent py-0.5 placeholder-gray-400"
                    />
                  </div>
                </div>
                <p className="text-[10px] text-gray-400">
                  Enter to add first match · Backspace to remove last · click chip ✕ to remove
                </p>

                {/* Dropdown — filtered or full browse */}
                {showTestList && (
                  <div className="border border-gray-200 rounded-lg divide-y max-h-64 overflow-y-auto bg-white shadow-lg">
                    {testGroups.length === 0 ? (
                      <div className="p-4 text-gray-500 text-sm">No tests or packages found.</div>
                    ) : (
                      testGroups
                        .filter((t) => {
                          if (!testSearch) return true;
                          const search = testSearch.toLowerCase();
                          return (
                            t.name.toLowerCase().includes(search) ||
                            (t.category && t.category.toLowerCase().includes(search)) ||
                            (t.code && t.code.toLowerCase().includes(search)) ||
                            (t.type === 'package' && 'package'.includes(search))
                          );
                        })
                        .map((t) => (
                          <label
                            key={t.id}
                            className={`flex items-center justify-between p-3 hover:bg-blue-50 cursor-pointer transition-colors ${t.type === 'package' ? 'bg-purple-50' : ''}`}
                          >
                            <div className="flex items-center gap-3">
                              <input
                                type="checkbox"
                                checked={selectedTests.includes(t.id)}
                                onChange={() => handleToggleTest(t.id)}
                                className="w-4 h-4 text-blue-600 flex-shrink-0"
                              />
                              <SampleTypeIndicator
                                sampleType={t.sample_type || 'Blood'}
                                sampleColor={t.sample_color || undefined}
                                size="sm"
                              />
                              <div>
                                <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                                  {t.name}
                                  {t.type === 'package' && (
                                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                                      📦 Package
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-500">
                                  {t.type === 'package'
                                    ? `${t.testGroupIds?.length || 0} tests included`
                                    : (t.category ?? 'General') + (t.requiresFasting ? ' • Fasting' : '')}
                                </div>
                              </div>
                            </div>
                            <div className="text-sm font-semibold text-gray-900">₹{t.price ?? 0}</div>
                          </label>
                        ))
                    )}
                  </div>
                )}
              </div>
            )}

            {(selectedTests.length > 0 || selectedBillingItems.length > 0 || billingItemTypes.length > 0) && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                {selectedTests.length > 0 && (<>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-green-900 flex items-center gap-2">
                    <TestTube className="h-4 w-4" />
                    Selected Tests & Packages ({selectedTests.length})
                  </h4>
                  <div className="flex items-center gap-1 bg-white rounded-lg p-1 border border-gray-200 shadow-sm">
                    <button
                      type="button"
                      onClick={() => setPriority('Normal')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        priority === 'Normal'
                          ? 'bg-gray-600 text-white shadow-sm'
                          : 'text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      Normal
                    </button>
                    <button
                      type="button"
                      onClick={() => setPriority('Urgent')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        priority === 'Urgent'
                          ? 'bg-orange-500 text-white shadow-sm'
                          : 'text-orange-600 hover:bg-orange-50'
                      }`}
                    >
                      ⚡ Urgent
                    </button>
                    <button
                      type="button"
                      onClick={() => setPriority('STAT')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                        priority === 'STAT'
                          ? 'bg-red-500 text-white shadow-sm animate-pulse'
                          : 'text-red-600 hover:bg-red-50'
                      }`}
                    >
                      🚨 STAT
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  {testGroups
                    .filter((t) => selectedTests.includes(t.id))
                    .map((t) => {
                      const outsourcingStatus = testOutsourcingConfig[t.id] || 'inhouse';
                      const isOutsourced = outsourcingStatus !== 'inhouse';
                      const outsourcedLab = isOutsourced ? outsourcedLabs.find(lab => lab.id === outsourcingStatus) : null;
                      const isPackage = t.type === 'package';

                      return (
                        <div key={t.id} className={`flex items-center justify-between gap-2 p-2 bg-white rounded border ${isPackage ? 'border-purple-200' : 'border-green-100'}`}>
                          <div className="flex-1">
                            <div className="flex items-center gap-3">
                              <SampleTypeIndicator
                                sampleType={t.sample_type || 'Blood'}
                                sampleColor={t.sample_color || undefined}
                                size="sm"
                              />
                              <span className={`${isPackage ? 'text-purple-800' : 'text-green-800'} font-medium`}>{t.name}</span>
                              {isPackage && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">
                                  📦 Package
                                </span>
                              )}
                              {isOutsourced && (
                                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                                  Outsourced
                                </span>
                              )}
                            </div>
                            {/* Show included tests for packages */}
                            {isPackage && t.testGroupIds && t.testGroupIds.length > 0 && (
                              <div className="text-xs text-purple-600 mt-1">
                                {t.testGroupIds.length} tests included
                              </div>
                            )}
                            {/* Outsource Lab Selector - only for non-packages */}
                            {!isPackage && (
                              <div className="mt-1 flex items-center gap-2">
                                <select
                                  value={outsourcingStatus}
                                  onChange={(e) => setTestOutsourcingConfig(config => ({
                                    ...config,
                                    [t.id]: e.target.value
                                  }))}
                                  className="text-xs px-2 py-1 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                >
                                  <option value="inhouse">🏠 In-house</option>
                                  {outsourcedLabs.map((lab) => (
                                    <option key={lab.id} value={lab.id}>
                                      🏥 {lab.name}
                                    </option>
                                  ))}
                                </select>
                                {isOutsourced && outsourcedLab && (
                                  <span className="text-xs text-orange-600">
                                    → {outsourcedLab.name}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex flex-col items-end">
                              {(() => {
                                const { price, source } = resolvePrice(t.id, t.price);
                                return (
                                  <>
                                    <span className={`font-medium ${isPackage ? 'text-purple-900' : 'text-green-900'} whitespace-nowrap`}>
                                      {currencySymbol}{price}
                                    </span>
                                    {source !== 'base' && (
                                      <span className={`text-[10px] font-medium px-1 rounded border ${
                                        source === 'account' 
                                          ? 'text-indigo-600 bg-indigo-50 border-indigo-100' 
                                          : 'text-orange-600 bg-orange-50 border-orange-100'
                                      }`}>
                                        {source === 'account' ? 'Account Price' : 'Location Price'}
                                      </span>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedTests(prev => prev.filter(id => id !== t.id));
                              }}
                              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                              title="Remove"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
                <div className="border-t border-green-200 mt-2 pt-2 flex justify-between font-semibold text-green-900">
                  <span>Tests Subtotal:</span>
                  <span>₹{totalAmount}</span>
                </div>
                </>)}

                {/* Extra Charges (Lab Billing Items) */}
                {selectedBillingItems.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {selectedBillingItems.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between text-sm bg-amber-50 border border-amber-100 rounded px-2 py-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-amber-700 font-medium truncate">{item.name}</span>
                          {item.is_shareable_with_doctor && <span className="text-xs text-blue-500 flex-shrink-0">Dr</span>}
                          {item.is_shareable_with_phlebotomist && <span className="text-xs text-orange-500 flex-shrink-0">Ph</span>}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <span className="text-amber-800 font-semibold">₹{item.amount}</span>
                          <button
                            type="button"
                            onClick={() => setSelectedBillingItems(prev => prev.filter((_, i) => i !== idx))}
                            className="text-red-400 hover:text-red-600 ml-1"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between text-sm font-semibold text-amber-700 px-1">
                      <span>Billing Items:</span>
                      <span>+₹{extraChargesTotal}</span>
                    </div>
                  </div>
                )}

                {/* Add Extra Charge */}
                {billingItemTypes.length > 0 && (
                  <div className="mt-2">
                    {!showAddBillingItem ? (
                      <button
                        type="button"
                        onClick={() => setShowAddBillingItem(true)}
                        className="w-full flex items-center justify-center gap-1 text-xs text-amber-700 bg-amber-50 border border-dashed border-amber-300 rounded-lg px-3 py-1.5 hover:bg-amber-100 transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Add Billing Item
                      </button>
                    ) : (
                      <div className="border border-amber-200 bg-amber-50 rounded-lg p-2 space-y-2">
                        <select
                          value={newBillingItemTypeId}
                          onChange={e => {
                            const t = billingItemTypes.find(x => x.id === e.target.value);
                            setNewBillingItemTypeId(e.target.value);
                            if (t) { setNewBillingItemName(t.name); setNewBillingItemAmount(String(t.default_amount)); }
                          }}
                          className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                        >
                          <option value="">— Select type —</option>
                          {billingItemTypes.map(t => (
                            <option key={t.id} value={t.id}>{t.name} (₹{t.default_amount})</option>
                          ))}
                        </select>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            placeholder="Name"
                            value={newBillingItemName}
                            onChange={e => setNewBillingItemName(e.target.value)}
                            className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                          <input
                            type="number"
                            placeholder="₹"
                            value={newBillingItemAmount}
                            onChange={e => setNewBillingItemAmount(e.target.value)}
                            className="w-20 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={!newBillingItemName.trim() || !newBillingItemAmount}
                            onClick={() => {
                              const t = billingItemTypes.find(x => x.id === newBillingItemTypeId);
                              setSelectedBillingItems(prev => [...prev, {
                                typeId: newBillingItemTypeId || null,
                                name: newBillingItemName.trim(),
                                amount: Number(newBillingItemAmount) || 0,
                                is_shareable_with_doctor: t?.is_shareable_with_doctor ?? false,
                                is_shareable_with_phlebotomist: t?.is_shareable_with_phlebotomist ?? false,
                              }]);
                              setNewBillingItemTypeId(''); setNewBillingItemName(''); setNewBillingItemAmount('');
                              setShowAddBillingItem(false);
                            }}
                            className="flex-1 text-xs px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50 transition-colors"
                          >
                            Add
                          </button>
                          <button
                            type="button"
                            onClick={() => { setShowAddBillingItem(false); setNewBillingItemTypeId(''); setNewBillingItemName(''); setNewBillingItemAmount(''); }}
                            className="text-xs px-3 py-1.5 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                          >Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {extraChargesTotal > 0 && (
                  <div className="border-t border-amber-200 mt-1 pt-1 flex justify-between font-semibold text-gray-900 text-sm">
                    <span>Grand Total (incl. charges):</span>
                    <span>₹{totalAmount + collectionCharge + extraChargesTotal}</span>
                  </div>
                )}

                {/* Monthly Billing Indicator */}
                {selectedAccount && accounts.find(a => a.id === selectedAccount)?.billing_mode === 'monthly' && (
                  <div className="mt-2 bg-purple-50 border border-purple-200 p-3 rounded-lg">
                    <div className="flex items-center gap-2 text-purple-900">
                      <Briefcase className="h-4 w-4" />
                      <span className="font-semibold">Monthly Billing Account</span>
                    </div>
                    <p className="text-xs text-purple-700 mt-1">
                      This order will be included in consolidated monthly billing for {accounts.find(a => a.id === selectedAccount)?.name}. No individual invoice will be generated.
                    </p>
                  </div>
                )}
                {selectedTests.length > 0 && (
                <div className="mt-2 text-xs text-green-700 bg-green-100 p-2 rounded">
                  💡 Tip: Select "In-house" for tests performed in your lab, or choose an outsourced lab if test is sent externally
                </div>
                )}
              </div>
            )}
          </section>

          {/* Required Patient Inputs (AI Context) */}
          {requiredInfos.length > 0 && (
            <section className="space-y-4 bg-purple-50 p-4 rounded-lg border border-purple-200">
              <h3 className="text-lg font-medium text-purple-900 flex items-center gap-2">
                <Sparkles className="h-5 w-5" />
                Additional Patient Information
              </h3>
              <p className="text-sm text-purple-700 -mt-2">
                Required for accurate reference range calculation for selected tests.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {requiredInfos.map(info => (
                  <div key={info}>
                    <label className="block text-sm font-medium text-purple-900 mb-1 capitalize">
                      {info.replace(/_/g, ' ')} <span className="text-red-500">*</span>
                    </label>

                    {info === 'pregnancy_status' ? (
                      <select
                        value={additionalInputs[info] || ''}
                        onChange={e => setAdditionalInputs(prev => ({ ...prev, [info]: e.target.value }))}
                        className="w-full px-3 py-2 border border-purple-300 rounded-md focus:ring-2 focus:ring-purple-500 bg-white"
                      >
                        <option value="">Select Status</option>
                        <option value="Not Pregnant">Not Pregnant</option>
                        <option value="Trimester 1">First Trimester (1-12 weeks)</option>
                        <option value="Trimester 2">Second Trimester (13-26 weeks)</option>
                        <option value="Trimester 3">Third Trimester (27+ weeks)</option>
                        <option value="Lactating">Lactating</option>
                      </select>
                    ) : info === 'lmp' ? (
                      <input
                        type="date"
                        value={additionalInputs[info] || ''}
                        onChange={e => setAdditionalInputs(prev => ({ ...prev, [info]: e.target.value }))}
                        className="w-full px-3 py-2 border border-purple-300 rounded-md focus:ring-2 focus:ring-purple-500"
                      />
                    ) : info === 'consent_form' ? (
                      <label className="flex items-center gap-2 px-3 py-2 border border-purple-300 rounded-md bg-white cursor-pointer">
                        <input
                          type="checkbox"
                          checked={additionalInputs[info] === 'yes'}
                          onChange={e => setAdditionalInputs(prev => ({ ...prev, [info]: e.target.checked ? 'yes' : '' }))}
                          className="h-4 w-4 text-purple-600 rounded focus:ring-purple-500"
                        />
                        <span className="text-sm text-gray-700">Patient has signed consent form</span>
                      </label>
                    ) : info === 'id_document' ? (
                      <input
                        type="text"
                        value={additionalInputs[info] || ''}
                        onChange={e => setAdditionalInputs(prev => ({ ...prev, [info]: e.target.value }))}
                        className="w-full px-3 py-2 border border-purple-300 rounded-md focus:ring-2 focus:ring-purple-500"
                        placeholder="Enter ID number (Aadhaar, etc.)"
                      />
                    ) : (
                      <input
                        type="text"
                        value={additionalInputs[info] || ''}
                        onChange={e => setAdditionalInputs(prev => ({ ...prev, [info]: e.target.value }))}
                        className="w-full px-3 py-2 border border-purple-300 rounded-md focus:ring-2 focus:ring-purple-500"
                        placeholder={`Enter ${info.replace(/_/g, ' ')}...`}
                      />
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Referring Doctor, Location, Bill-to Account */}
          <section className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Referring Doctor */}
              <div className="md:col-span-3 relative" style={{ minHeight: showDoctorDropdown ? '230px' : 'auto' }}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Referring Doctor
                  <span className="ml-1 text-xs text-gray-400 font-normal">(optional)</span>
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                  <input
                    ref={doctorInputRef}
                    type="text"
                    placeholder="Search doctor or leave as Self…"
                    value={doctorSearch}
                    onChange={(e) => {
                      setDoctorSearch(e.target.value);
                      setHighlightedDoctorIndex(-1);
                      setShowDoctorDropdown(true);
                    }}
                    onFocus={(e) => { e.target.select(); setShowDoctorDropdown(true); e.currentTarget.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                    onKeyDown={(e) => {
                      // total items = Self (index 0) + filteredDoctors
                      const total = 1 + filteredDoctors.length;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setShowDoctorDropdown(true);
                        setHighlightedDoctorIndex(i => Math.min(i + 1, total - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setHighlightedDoctorIndex(i => Math.max(i - 1, 0));
                      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') {
                        const onlyOne = filteredDoctors.length === 1 && highlightedDoctorIndex < 0;
                        if (highlightedDoctorIndex >= 0 || onlyOne) {
                          e.preventDefault();
                          const idx = onlyOne ? 1 : highlightedDoctorIndex;
                          if (idx === 0) {
                            setSelectedDoctor('SELF'); setDoctorSearch('Self / Walk-in');
                          } else {
                            const doc = filteredDoctors[idx - 1];
                            setSelectedDoctor(doc.id); setDoctorSearch(doc.name);
                          }
                          setShowDoctorDropdown(false);
                          setHighlightedDoctorIndex(-1);
                          setTimeout(() => locationInputRef.current?.focus(), 50);
                        } else if (e.key === 'Tab') {
                          e.preventDefault();
                          setShowDoctorDropdown(false);
                          setTimeout(() => locationInputRef.current?.focus(), 50);
                        }
                      } else if (e.key === 'Escape') {
                        setShowDoctorDropdown(false);
                        setHighlightedDoctorIndex(-1);
                        setTimeout(() => locationInputRef.current?.focus(), 50);
                      }
                    }}
                    onBlur={() => setTimeout(() => {
                      setShowDoctorDropdown(false);
                      setHighlightedDoctorIndex(-1);
                      // Only reset to Self/Walk-in if the search field was completely emptied
                      // Do NOT reset when selectedDoctor is SELF but user typed a search query
                      // (they may just be searching for a doctor to pick)
                      setDoctorSearch((currentSearch) => {
                        if (!currentSearch.trim()) {
                          setSelectedDoctor('SELF');
                          return 'Self / Walk-in';
                        }
                        return currentSearch;
                      });
                    }, 250)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
                  />
                  {showDoctorDropdown && (
                    <div className="absolute z-[100] w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-2xl max-h-48 overflow-y-auto">
                      {/* Self / Walk-in always as first option */}
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedDoctor('SELF');
                          setDoctorSearch('Self / Walk-in');
                          setShowDoctorDropdown(false);
                          setTimeout(() => locationInputRef.current?.focus(), 50);
                        }}
                        className={`w-full px-4 py-2 text-left transition-colors border-b border-gray-100 ${
                          highlightedDoctorIndex === 0 ? 'bg-blue-100' : selectedDoctor === 'SELF' ? 'bg-blue-50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="font-medium text-gray-700">Self / Walk-in</div>
                        <div className="text-xs text-gray-400">No referring doctor</div>
                      </button>
                      {filteredDoctors.map((doctor, idx) => (
                        <button
                          key={doctor.id}
                          type="button"
                          onClick={() => {
                            setSelectedDoctor(doctor.id);
                            setDoctorSearch(doctor.name);
                            setShowDoctorDropdown(false);
                            setHighlightedDoctorIndex(-1);
                            setTimeout(() => locationInputRef.current?.focus(), 50);
                          }}
                          className={`w-full px-4 py-2 text-left transition-colors ${
                            highlightedDoctorIndex === idx + 1 ? 'bg-blue-100' : selectedDoctor === doctor.id ? 'bg-blue-50' : 'hover:bg-blue-50'
                          }`}
                        >
                          <div className="font-medium text-gray-900">{doctor.name}</div>
                          {doctor.specialization && (
                            <div className="text-xs text-gray-500">{doctor.specialization}</div>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  </div>
                  {/* Quick-Add Doctor button */}
                  <button
                    type="button"
                    onClick={() => setShowAddDoctorModal(true)}
                    title="Add new doctor"
                    className="flex-shrink-0 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-1"
                  >
                    <UserPlus className="h-4 w-4" />
                    <span className="text-xs hidden sm:inline">New</span>
                  </button>
                </div>
                {selectedDoctor !== 'SELF' && selectedDoctor && (
                  <button
                    type="button"
                    onClick={() => { setSelectedDoctor('SELF'); setDoctorSearch('Self / Walk-in'); }}
                    className="mt-1 text-xs text-gray-400 hover:text-gray-600 underline"
                  >
                    Clear (set to Self)
                  </button>
                )}
              </div>

              {/* Location (collection/origin) */}
              <div className="md:col-span-3 relative" style={{ minHeight: showLocationDropdown && filteredLocations.length > 0 ? '230px' : 'auto' }}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Location {paymentType !== 'self' && '(required if no Account)'}
                </label>
                <div className="relative">
                  <input
                    ref={locationInputRef}
                    type="text"
                    placeholder="Search location…"
                    value={locationSearch}
                    onChange={(e) => {
                      setLocationSearch(e.target.value);
                      setHighlightedLocationIndex(-1);
                      setShowLocationDropdown(true);
                    }}
                    onFocus={(e) => { setShowLocationDropdown(true); e.currentTarget.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setShowLocationDropdown(true);
                        setHighlightedLocationIndex(i => Math.min(i + 1, filteredLocations.length - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setHighlightedLocationIndex(i => Math.max(i - 1, 0));
                      } else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') && (highlightedLocationIndex >= 0 || filteredLocations.length === 1)) {
                        e.preventDefault();
                        const idx = highlightedLocationIndex >= 0 ? highlightedLocationIndex : 0;
                        const loc = filteredLocations[idx];
                        setSelectedLocation(loc.id); setLocationSearch(loc.name);
                        setShowLocationDropdown(false); setHighlightedLocationIndex(-1);
                        setTimeout(() => accountInputRef.current?.focus(), 50);
                      } else if (e.key === 'Tab') {
                        e.preventDefault();
                        setShowLocationDropdown(false);
                        setTimeout(() => accountInputRef.current?.focus(), 50);
                      } else if (e.key === 'Escape') {
                        setShowLocationDropdown(false); setHighlightedLocationIndex(-1);
                        setTimeout(() => accountInputRef.current?.focus(), 50);
                      }
                    }}
                    onBlur={() => setTimeout(() => { setShowLocationDropdown(false); setHighlightedLocationIndex(-1); }, 200)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showLocationDropdown && filteredLocations.length > 0 && (
                    <div className="absolute z-[100] w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-2xl max-h-48 overflow-y-auto">
                      {filteredLocations.map((location, idx) => (
                        <button
                          key={location.id}
                          type="button"
                          onClick={() => {
                            setSelectedLocation(location.id);
                            setLocationSearch(location.name);
                            setShowLocationDropdown(false);
                            setHighlightedLocationIndex(-1);
                            setTimeout(() => accountInputRef.current?.focus(), 50);
                          }}
                          className={`w-full px-4 py-2 text-left flex items-center gap-2 transition-colors ${
                            highlightedLocationIndex === idx ? 'bg-blue-100' : 'hover:bg-blue-50'
                          }`}
                        >
                          <Building className="w-4 h-4 text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900">{location.name}</div>
                            <div className="text-xs text-gray-500">
                              {location.type.replace(/_/g, ' ')}
                              {location.credit_limit ? ` • Credit: ₹${location.credit_limit}` : ''}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Bill-to Account (optional, used for B2B) */}
              <div className="md:col-span-3 relative" style={{ minHeight: showAccountDropdown && filteredAccounts.length > 0 ? '230px' : 'auto' }}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Bill-to Account (optional for credit/corporate/insurance)
                </label>
                <div className="relative">
                  <input
                    ref={accountInputRef}
                    type="text"
                    placeholder="Search account (hospital / corporate / insurer)…"
                    value={accountSearch}
                    onChange={(e) => {
                      setAccountSearch(e.target.value);
                      setHighlightedAccountIndex(-1);
                      setShowAccountDropdown(true);
                    }}
                    onFocus={(e) => {
                      setShowAccountDropdown(true);
                      e.currentTarget.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setShowAccountDropdown(true);
                        setHighlightedAccountIndex(i => Math.min(i + 1, filteredAccounts.length - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setHighlightedAccountIndex(i => Math.max(i - 1, 0));
                      } else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Tab') && (highlightedAccountIndex >= 0 || filteredAccounts.length === 1)) {
                        e.preventDefault();
                        const idx = highlightedAccountIndex >= 0 ? highlightedAccountIndex : 0;
                        const acc = filteredAccounts[idx];
                        if (isAccountEffectivelyLocked(acc)) return; // locked accounts can't be selected
                        setSelectedAccount(acc.id); setAccountSearch(acc.name);
                        setShowAccountDropdown(false); setHighlightedAccountIndex(-1);
                        setTimeout(() => {
                          (createAndNewButtonRef.current || createOrderButtonRef.current)?.focus();
                        }, 50);
                      } else if (e.key === 'Tab' || e.key === 'Escape') {
                        e.preventDefault();
                        setShowAccountDropdown(false); setHighlightedAccountIndex(-1);
                        setTimeout(() => {
                          (createAndNewButtonRef.current || createOrderButtonRef.current)?.focus();
                        }, 50);
                      }
                    }}
                    onBlur={() => setTimeout(() => { setShowAccountDropdown(false); setHighlightedAccountIndex(-1); }, 200)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {showAccountDropdown && filteredAccounts.length > 0 && (
                    <div className="absolute z-[100] w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-2xl max-h-48 overflow-y-auto">
                      {filteredAccounts.map((account, idx) => {
                        const locked = isAccountEffectivelyLocked(account);
                        return (
                        <button
                          key={account.id}
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            if (locked) return;
                            setSelectedAccount(account.id);
                            setAccountSearch(account.name);
                            setShowAccountDropdown(false);
                            setHighlightedAccountIndex(-1);
                          }}
                          title={locked ? 'This account is locked — an admin must open it in Account Master.' : undefined}
                          className={`w-full px-4 py-2 text-left flex items-center gap-2 transition-colors ${
                            locked ? 'opacity-60 cursor-not-allowed bg-red-50' : highlightedAccountIndex === idx ? 'bg-blue-100' : 'hover:bg-blue-50'
                          }`}
                        >
                          <Briefcase className="w-4 h-4 text-gray-400" />
                          <div>
                            <div className="font-medium text-gray-900 flex items-center gap-1.5">
                              {account.name}
                              {locked && <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700">🔒 Locked</span>}
                            </div>
                            <div className="text-xs text-gray-500">
                              {account.type}
                              {account.credit_limit ? ` • Credit: ₹${account.credit_limit}` : ''}
                            </div>
                          </div>
                        </button>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    If selected, the invoice and credit tracking will be under this Account. Otherwise they remain location-based.
                  </p>
                </div>
              </div>
            </div>

            {/* Credit Info */}
            {creditInfo && paymentType !== 'self' && (
              <div
                className={`p-4 rounded-lg ${creditInfo.allowed
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
                  }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <CreditCard
                    className={`w-5 h-5 ${creditInfo.allowed ? 'text-green-600' : 'text-red-600'}`}
                  />
                  <h4
                    className={`font-medium ${creditInfo.allowed ? 'text-green-900' : 'text-red-900'
                      }`}
                  >
                    {creditInfo.kind === 'account' ? 'Account' : 'Location'} Credit
                  </h4>
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-gray-600">Name:</span>
                    <div className="font-medium">{creditInfo.name}</div>
                  </div>
                  <div>
                    <span className="text-gray-600">Credit Limit:</span>
                    <div className="font-medium">₹{creditInfo.creditLimit.toLocaleString()}</div>
                  </div>
                  <div>
                    <span className="text-gray-600">Credit Used:</span>
                    <div className="font-medium">
                      ₹{creditInfo.currentBalance.toLocaleString()}
                    </div>
                  </div>
                  <div className="col-span-3">
                    <span className="text-gray-600">Available Credit:</span>{' '}
                    <span
                      className={`font-medium ${creditInfo.allowed ? 'text-green-600' : 'text-red-600'
                        }`}
                    >
                      ₹{creditInfo.availableCredit.toLocaleString()}
                    </span>
                    {!!creditInfo.manualPaymentCredit && creditInfo.manualPaymentCredit > 0 && (
                      <span className="text-gray-500">
                        {' '}(includes ₹{creditInfo.manualPaymentCredit.toLocaleString()} cash/cheque received)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Order Details — collapsible */}
          <section className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setOrderDetailsOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="text-base font-medium text-gray-900 flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Order Details
              </span>
              <ChevronDown
                className={`h-4 w-4 text-gray-500 transition-transform ${orderDetailsOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {orderDetailsOpen && (
              <div className="px-4 pb-4 border-t border-gray-100">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4">
                  {/* Priority */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as any)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {['Normal', 'Urgent', 'STAT'].map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Admin: Backdated Order */}
                  {isAdmin && (
                    <div>
                      <label className="block text-sm font-medium text-purple-700 mb-1 flex items-center gap-1">
                        <ClockIcon className="w-3.5 h-3.5" />
                        Order Date (Admin)
                      </label>
                      <input
                        type="datetime-local"
                        value={customOrderDate}
                        onChange={(e) => setCustomOrderDate(e.target.value)}
                        max={new Date().toISOString().slice(0, 16)}
                        className="w-full px-3 py-2 border border-purple-300 bg-purple-50 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                      />
                      <p className="text-[10px] text-purple-600 mt-0.5">Leave empty for today (now)</p>
                    </div>
                  )}

                  {/* Admin: Report Date Override */}
                  {isAdmin && customOrderDate && (
                    <div>
                      <label className="block text-sm font-medium text-purple-700 mb-1 flex items-center gap-1">
                        <ClockIcon className="w-3.5 h-3.5" />
                        Report Date (Admin)
                      </label>
                      <input
                        type="date"
                        value={customReportDate}
                        onChange={(e) => setCustomReportDate(e.target.value)}
                        className="w-full px-3 py-2 border border-purple-300 bg-purple-50 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                      />
                      <p className="text-[10px] text-purple-600 mt-0.5">Leave empty to use report generation date</p>
                    </div>
                  )}

                  {/* Expected Date */}
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Expected Date
                    </label>
                    <input
                      type="date"
                      value={expectedDate}
                      onChange={(e) => setExpectedDate(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  {/* Expected TAT Display */}
                  {selectedTests.length > 0 && (
                    <div className="md:col-span-3 bg-gray-50 p-3 rounded-md border border-gray-200 flex items-center gap-2">
                      <ClockIcon className="w-4 h-4 text-gray-500" />
                      <span className="text-sm text-gray-700">
                        <span className="font-medium">Expected TAT:</span>{' '}
                        {(() => {
                          const selectedDetails = testGroups.filter(t => selectedTests.includes(t.id));
                          const tats = selectedDetails.map(t => t.turnaroundTime).filter(Boolean);
                          if (tats.length === 0) return 'Not specified';
                          const uniqueTats = Array.from(new Set(tats));
                          return uniqueTats.join(', ');
                        })()}
                      </span>
                    </div>
                  )}

                  {/* Payment Type */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Payment Type
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {(['self', 'credit', 'insurance', 'corporate'] as const).map((type) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => setPaymentType(type)}
                          className={`px-3 py-2 rounded-md text-sm font-medium ${paymentType === type
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                        >
                          {type.charAt(0).toUpperCase() + type.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Pre-barcoded sample */}
          <section className="border border-gray-200 rounded-lg p-4 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-800">
              <input
                type="checkbox"
                checked={preBarcoded}
                onChange={(e) => {
                  setPreBarcoded(e.target.checked);
                  if (!e.target.checked) setPreBarcode('');
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              Pre-barcoded sample
            </label>
            {preBarcoded && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Manual tube barcode
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={preBarcode}
                    onChange={(e) => setPreBarcode(e.target.value.replace(/\D/g, '').slice(0, 12))}
                    placeholder="Scan or enter barcode"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="text-xs text-gray-500 flex items-end">
                  Numeric only. Supports existing 10-digit labels and 12-digit YYYYMMDD sequence labels.
                </div>
              </div>
            )}
          </section>

          {/* Additional Notes - collapsed by default for faster registration */}
          <section className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setClinicalNotesOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition-colors"
            >
              <span className="text-base font-medium text-gray-900 flex items-center gap-2">
                <Stethoscope className="h-4 w-4" />
                Additional Notes
                {notes.trim() && (
                  <span className="text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                    Added
                  </span>
                )}
              </span>
              <ChevronDown
                className={`h-4 w-4 text-gray-500 transition-transform ${clinicalNotesOpen ? 'rotate-180' : ''}`}
              />
            </button>
            {clinicalNotesOpen && (
              <div className="px-4 pb-4 border-t border-gray-100">
                <label className="block text-sm font-medium text-gray-700 mb-1 pt-4">Clinical Notes</label>
                <textarea
                  ref={clinicalNotesRef}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Any special instructions or clinical notes..."
                  onFocus={(e) => e.currentTarget.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
          </section>

          {/* Discount & Payment Section */}
          {(selectedTests.length > 0 || selectedBillingItems.length > 0) && (
            <section className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Billing & Payment
              </h3>

              {/* Amount Breakdown */}
              <div className="bg-gray-50 p-4 rounded-lg space-y-2">
                {selectedTests.length > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Subtotal ({selectedTests.length} tests)</span>
                  <span className="font-medium">{currencySymbol}{totalAmount.toLocaleString()}</span>
                </div>
                )}

                {/* Sample Collection Charge */}
                <div className="flex items-center justify-between text-sm border-t pt-2">
                  <label className="flex items-center gap-1.5 text-gray-700">
                    <Truck className="h-3.5 w-3.5 text-orange-500" />
                    Collection Charge
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={collectionCharge}
                      onChange={(e) => setCollectionCharge(Number(e.target.value))}
                      className="w-24 px-2 py-1 text-sm border border-gray-300 rounded-md text-right focus:ring-2 focus:ring-orange-400"
                    />
                    <span className="text-gray-500 text-xs">{currencySymbol}</span>
                  </div>
                </div>

                {/* Discount Input */}
                <div className="flex items-center gap-3 border-t pt-2">
                  <label className="text-sm font-medium text-gray-700 min-w-[80px]">Discount</label>
                  <div className="flex gap-2 flex-1">
                    <button
                      type="button"
                      onClick={() => setDiscountType(discountType === 'percentage' ? 'fixed' : 'percentage')}
                      className="px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-100 bg-white"
                    >
                      {discountType === 'percentage' ? '%' : currencySymbol}
                    </button>
                    <input
                      type="number"
                      min="0"
                      max={discountType === 'percentage' ? 100 : totalAmount}
                      value={discountValue}
                      onChange={(e) => setDiscountValue(Number(e.target.value))}
                      placeholder={`Enter discount${discountType === 'percentage' ? ' %' : ''}`}
                      className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                {/* Discount By — determines if discount should affect doctor commission */}
                {discountValue > 0 && (
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-medium text-gray-700 min-w-[80px]">Given by</label>
                    <div className="flex rounded-md border border-gray-300 overflow-hidden text-xs">
                      <button
                        type="button"
                        onClick={() => setDiscountBy('lab')}
                        className={`px-3 py-1.5 ${discountBy === 'lab' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                      >
                        Lab
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountBy('doctor')}
                        className={`px-3 py-1.5 border-l border-gray-300 ${discountBy === 'doctor' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                      >
                        Doctor
                      </button>
                    </div>
                    <span className="text-xs text-gray-500">
                      {discountBy === 'doctor' ? 'Deducted from doctor commission' : 'Absorbed by lab'}
                    </span>
                  </div>
                )}

                {discountAmount > 0 && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Discount ({discountType === 'percentage' ? `${discountValue}%` : `${currencySymbol}${discountValue}`})</span>
                    <span>-{currencySymbol}{discountAmount.toLocaleString()}</span>
                  </div>
                )}

                {/* Loyalty Points Redemption */}
                {loyaltyEnabled && selectedPatient && (
                  <div className="border-t pt-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={loyaltyRedeemEnabled}
                          onChange={(e) => {
                            setLoyaltyRedeemEnabled(e.target.checked);
                            if (!e.target.checked) setLoyaltyPointsToRedeem(0);
                          }}
                          disabled={loyaltyBalance < loyaltyMinRedeem}
                          className="rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                        />
                        <Gift className="h-4 w-4 text-amber-600" />
                        <span className="text-gray-700 font-medium">Use Loyalty Points</span>
                      </label>
                      <span className="text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                        {loyaltyBalance} pts available
                      </span>
                    </div>

                    {loyaltyBalance < loyaltyMinRedeem && (
                      <p className="text-xs text-gray-500 ml-6">
                        Minimum {loyaltyMinRedeem} points required to redeem
                      </p>
                    )}

                    {loyaltyRedeemEnabled && loyaltyBalance >= loyaltyMinRedeem && (
                      <div className="flex items-center gap-3 ml-6">
                        <input
                          type="number"
                          min={loyaltyMinRedeem}
                          max={Math.min(loyaltyBalance, Math.floor((totalAmount - discountAmount) / loyaltyPointValue))}
                          value={loyaltyPointsToRedeem}
                          onChange={(e) => {
                            const val = parseInt(e.target.value) || 0;
                            const maxRedeemable = Math.min(loyaltyBalance, Math.floor((totalAmount - discountAmount) / loyaltyPointValue));
                            setLoyaltyPointsToRedeem(Math.min(val, maxRedeemable));
                          }}
                          placeholder="Points to redeem"
                          className="flex-1 px-3 py-1.5 text-sm border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-500 bg-amber-50"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const maxRedeemable = Math.min(loyaltyBalance, Math.floor((totalAmount - discountAmount) / loyaltyPointValue));
                            setLoyaltyPointsToRedeem(maxRedeemable);
                          }}
                          className="px-2 py-1.5 text-xs bg-amber-100 text-amber-700 border border-amber-300 rounded-md hover:bg-amber-200"
                        >
                          Max
                        </button>
                      </div>
                    )}

                    {loyaltyDiscountAmount > 0 && (
                      <div className="flex justify-between text-sm text-amber-700">
                        <span>Loyalty Discount ({loyaltyPointsToRedeem} pts)</span>
                        <span>-{currencySymbol}{loyaltyDiscountAmount.toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex justify-between text-base font-semibold border-t pt-2">
                  <span>Final Amount</span>
                  <span className="text-blue-600">{currencySymbol}{finalAmount.toLocaleString()}</span>
                </div>
              </div>

              {/* Payment Collection — hidden for monthly billing accounts */}
              {!isMonthlyBillingAccount && <div className="border-t pt-3">
                <label className="block text-sm font-medium text-gray-700 mb-2">Collect Payment (Optional)</label>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as any)}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card</option>
                      <option value="upi">UPI</option>
                      <option value="online">Online</option>
                    </select>
                  </div>
                  <div>
                    <input
                      type="number"
                      min="0"
                      max={finalAmount}
                      value={amountPaid}
                      onChange={(e) => setAmountPaid(Number(e.target.value))}
                      placeholder="Amount received"
                      disabled={takeFullPayment}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <label className="mt-2 inline-flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={takeFullPayment}
                    onChange={(e) => setTakeFullPayment(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  Take Full Payment (Auto-fill net payable)
                </label>

                {amountPaid > 0 && (
                  <div className="mt-2 p-2 bg-blue-50 rounded text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">Paid:</span>
                      <span className="font-medium text-green-600">{currencySymbol}{amountPaid.toLocaleString()}</span>
                    </div>
                    {balanceDue > 0 && (
                      <div className="flex justify-between mt-1">
                        <span className="text-gray-600">Balance Due:</span>
                        <span className="font-medium text-red-600">{currencySymbol}{balanceDue.toLocaleString()}</span>
                      </div>
                    )}
                    {balanceDue < 0 && (
                      <div className="flex justify-between mt-1">
                        <span className="text-gray-600">Change:</span>
                        <span className="font-medium text-orange-600">{currencySymbol}{Math.abs(balanceDue).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                )}

                {isOnlineCollection ? (
                  <p className="text-xs text-blue-600 mt-2">
                    💳 A payment QR / link will be shown after the order is registered. The invoice is
                    marked paid automatically once the gateway confirms.
                  </p>
                ) : (
                  <p className="text-xs text-gray-500 mt-2">
                    💡 Leave empty to collect payment later via invoice
                  </p>
                )}
              </div>}
            </section>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between border-t pt-6">
            <div className="text-sm text-gray-600">
              {(selectedTests.length > 0 || selectedBillingItems.length > 0) ? (
                <span className="font-medium">Total: {currencySymbol}{finalAmount}</span>
              ) : (
                <span>Select tests or add billing items to proceed.</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmitting}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                ref={createAndNewButtonRef}
                onClick={() => { submitModeRef.current = 'new'; }}
                disabled={isSubmitting}
                className="px-4 py-2 border border-blue-600 text-blue-700 bg-white rounded-md hover:bg-blue-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isSubmitting && submitModeRef.current === 'new' ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" />
                    <span>Creating...</span>
                  </>
                ) : (
                  <span>Create & New</span>
                )}
              </button>
              <button
                type="submit"
                ref={createOrderButtonRef}
                onClick={() => { submitModeRef.current = 'close'; }}
                disabled={isSubmitting}
                className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader className="h-4 w-4 animate-spin" />
                    <span>Creating Order...</span>
                  </>
                ) : (
                  <span>Create Order{(selectedTests.length > 0 || selectedBillingItems.length > 0) ? ` – ${currencySymbol}${finalAmount}` : ''}</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Quick-Add Doctor Modal */}
      {showAddDoctorModal && (
        <div className="fixed inset-0 bg-black/50 z-[200] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <UserPlus className="h-5 w-5 text-blue-600" />
                Add New Doctor
              </h3>
              <button
                type="button"
                onClick={() => { setShowAddDoctorModal(false); setNewDoctorData({ name: '', specialization: '', phone: '', hospital: '' }); }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  value={newDoctorData.name}
                  onChange={(e) => setNewDoctorData(p => ({ ...p, name: e.target.value }))}
                  autoFocus
                  placeholder="Dr. John Smith"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Specialization</label>
                <input
                  type="text"
                  value={newDoctorData.specialization}
                  onChange={(e) => setNewDoctorData(p => ({ ...p, specialization: e.target.value }))}
                  placeholder="General Medicine"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                <input
                  type="text"
                  value={newDoctorData.phone}
                  onChange={(e) => setNewDoctorData(p => ({ ...p, phone: e.target.value }))}
                  placeholder="+91 9999999999"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Hospital / Clinic</label>
                <input
                  type="text"
                  value={newDoctorData.hospital}
                  onChange={(e) => setNewDoctorData(p => ({ ...p, hospital: e.target.value }))}
                  placeholder="City Hospital"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button
                type="button"
                onClick={() => { setShowAddDoctorModal(false); setNewDoctorData({ name: '', specialization: '', phone: '', hospital: '' }); }}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddDoctor}
                disabled={!newDoctorData.name.trim() || addingDoctor}
                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {addingDoctor ? (
                  <><Loader className="h-4 w-4 animate-spin" /> Adding...</>
                ) : (
                  <>Add Doctor</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New Patient Modal */}
      {showNewPatientModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowNewPatientModal(false);
              setNewPatientCustomFields({});
              npResetNameFields();
              setTimeout(() => patientInputRef.current?.focus(), 50);
            }
          }}
        >
          <div ref={newPatientModalRef} className="bg-white rounded-lg shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Add New Patient</h3>
              <button
                onClick={() => {
                  setShowNewPatientModal(false);
                  setNewPatientCustomFields({});
                  npResetNameFields();
                  setTimeout(() => patientInputRef.current?.focus(), 50);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const composedName = npGetFullName() || newPatient.name;
                if (!npFirstName.trim() && !composedName) return;
                if (!newPatient.age || !newPatient.phone) return;
                try {
                  setCreatingPatient(true);
                  const payload: any = {
                    name: formatName((npGetFullName() || newPatient.name).trim(), nameCaseFormat),
                    age: parseInt(newPatient.age, 10),
                    age_unit: newPatient.age_unit,
                    gender: newPatient.gender,
                    phone: newPatient.phone.trim(),
                    email: newPatient.email?.trim() || null,
                    date_of_birth: newPatient.dob || null,
                    custom_fields: Object.keys(newPatientCustomFields).length > 0 ? newPatientCustomFields : null,
                    // sensible defaults
                    address: '',
                    city: '',
                    state: '',
                    pincode: '',
                    emergency_contact: null,
                    emergency_phone: null,
                    blood_group: null,
                    allergies: null,
                    medical_history: null,
                    total_tests: 0,
                    is_active: true,
                    referring_doctor: null,
                    default_doctor_id: (selectedDoctor && selectedDoctor !== SELF_DOCTOR_ID) ? selectedDoctor : null,
                    default_location_id: selectedLocation || null,
                    default_payment_type: paymentType || 'self'
                  };

                  const { data, error } = await (database as any).patients?.create?.(payload);
                  if (error) {
                    console.error(error);
                    alert('Failed to create patient');
                    return;
                  }
                  if (data) {
                    setPatients((prev) => [...prev, data]);
                    setShowNewPatientModal(false);
                    setNewPatient({ name: '', age: '', age_unit: 'years', gender: 'Male', phone: '', email: '', dob: '' });
                    setNewPatientCustomFields({});
                    npResetNameFields();
                    onPickPatient(data); // selects patient + advances focus to test search
                  }
                } catch (err) {
                  console.error(err);
                  alert('Error creating patient');
                } finally {
                  setCreatingPatient(false);
                }
              }}
              className="p-6 space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* ── Patient Name (split fields) ── */}
                <div className="md:col-span-2 space-y-2">
                  <label className="block text-sm font-medium text-gray-700">Patient Name *</label>

                  {/* Row 1: Salutation (optional) + First Name */}
                  <div className="flex gap-2">
                    {patientFormSettings.show_salutation && (
                      <select
                        value={npSalutation}
                        onChange={e => setNpSalutation(e.target.value)}
                        className="w-[96px] shrink-0 px-2 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                      >
                        <option value="">Salute</option>
                        {NP_SALUTATIONS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    )}
                    <input
                      type="text"
                      required
                      autoComplete="new-password"
                      placeholder="First Name *"
                      value={npFirstName}
                      onChange={e => setNpFirstName(e.target.value)}
                      style={npNameInputStyle}
                      className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  {/* Row 2: Middle (optional) + Last Name */}
                  <div className="flex gap-2">
                    {patientFormSettings.show_middle_name && (
                      <input
                        type="text"
                        autoComplete="new-password"
                        placeholder="Middle Name"
                        value={npMiddleName}
                        onChange={e => setNpMiddleName(e.target.value)}
                        style={npNameInputStyle}
                        className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    )}
                    <input
                      type="text"
                      autoComplete="new-password"
                      placeholder="Last Name"
                      value={npLastName}
                      onChange={e => setNpLastName(e.target.value)}
                      style={npNameInputStyle}
                      className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>

                  {/* Preview */}
                  {npGetFullName() && (
                    <p className="text-xs text-gray-500">
                      Saved as: <span className="font-semibold text-gray-700">{npGetFullName()}</span>
                    </p>
                  )}
                </div>

                {/* ── Date of Birth ── */}
                {(patientFormSettings.age_mode === 'dob' || patientFormSettings.age_mode === 'both') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Date of Birth{patientFormSettings.age_mode === 'dob' ? ' *' : ''}</label>
                    <input
                      type="date"
                      required={patientFormSettings.age_mode === 'dob'}
                      max={new Date().toISOString().split('T')[0]}
                      value={newPatient.dob}
                      onChange={(e) => {
                        const dob = e.target.value;
                        if (dob) {
                          const calc = calcAgeFromDob(dob);
                          setNewPatient((p) => ({ ...p, dob, age: calc.age, age_unit: calc.age_unit }));
                        } else {
                          setNewPatient((p) => ({ ...p, dob: '' }));
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                    />
                  </div>
                )}

                {/* ── Age ── */}
                {(patientFormSettings.age_mode === 'age' || patientFormSettings.age_mode === 'both') && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Age *{newPatient.dob && patientFormSettings.age_mode === 'both' && <span className="ml-1 text-xs text-blue-500 font-normal">(auto-calculated)</span>}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={0}
                        required
                        value={newPatient.age}
                        onChange={(e) => setNewPatient((p) => ({ ...p, age: e.target.value }))}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                        placeholder="Age"
                      />
                      <select
                        value={newPatient.age_unit}
                        onChange={(e) => setNewPatient((p) => ({ ...p, age_unit: e.target.value as 'years' | 'months' | 'days' }))}
                        className="w-24 px-2 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm bg-gray-50"
                      >
                        <option value="years">Years</option>
                        <option value="months">Months</option>
                        <option value="days">Days</option>
                      </select>
                    </div>
                  </div>
                )}

                {/* ── Gender ── */}
                {patientFormSettings.show_gender && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Gender *</label>
                    <div className="flex items-center gap-2 flex-wrap">
                      {patientFormSettings.gender_options.map(g => (
                        <button
                          key={g}
                          type="button"
                          onClick={() => { setNewPatient(p => ({ ...p, gender: g })); setNpGenderAutoDetected(false); setNpGenderManuallySet(true); }}
                          className={`px-3 py-1.5 text-sm font-medium rounded-full border transition-all ${
                            newPatient.gender === g
                              ? g === 'Male'
                                ? 'bg-blue-50 border-blue-400 text-blue-700'
                                : g === 'Female'
                                  ? 'bg-pink-50 border-pink-400 text-pink-700'
                                  : 'bg-purple-50 border-purple-400 text-purple-700'
                              : 'border-gray-300 text-gray-500 hover:border-gray-400'
                          }`}
                        >
                          {g}
                        </button>
                      ))}
                      {npGenderAutoDetected && newPatient.gender && (
                        <span className="flex items-center gap-0.5 text-[11px] text-amber-600 font-medium">
                          <Sparkles className="w-3 h-3" /> Auto
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Phone ── */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone{patientFormSettings.phone_required ? ' *' : ''}</label>
                  <input
                    type="tel"
                    required={patientFormSettings.phone_required}
                    autoComplete="new-password"
                    value={newPatient.phone}
                    onChange={(e) => setNewPatient((p) => ({ ...p, phone: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                  />
                </div>

                {/* ── Email ── */}
                {patientFormSettings.show_email && (
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email{patientFormSettings.email_required ? ' *' : ''}</label>
                    <input
                      type="email"
                      required={patientFormSettings.email_required}
                      autoComplete="new-password"
                      value={newPatient.email}
                      onChange={(e) => setNewPatient((p) => ({ ...p, email: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                    />
                  </div>
                )}

                {/* ── Custom Fields ── */}
                {allPatientFieldConfigs.map((field) => (
                  <div key={field.field_key} className={field.field_type === 'text' || field.field_type === 'textarea' ? 'md:col-span-2' : ''}>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {field.label}{field.required ? ' *' : ''}
                    </label>
                    {field.field_type === 'select' && field.options ? (
                      <select
                        required={field.required}
                        value={newPatientCustomFields[field.field_key] ?? ''}
                        onChange={(e) => setNewPatientCustomFields((p) => ({ ...p, [field.field_key]: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                      >
                        <option value="">Select…</option>
                        {field.options.map((opt: string) => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : field.field_type === 'textarea' ? (
                      <textarea
                        required={field.required}
                        value={newPatientCustomFields[field.field_key] ?? ''}
                        onChange={(e) => setNewPatientCustomFields((p) => ({ ...p, [field.field_key]: e.target.value }))}
                        rows={2}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                      />
                    ) : (
                      <input
                        type={field.field_type === 'number' ? 'number' : field.field_type === 'date' ? 'date' : 'text'}
                        required={field.required}
                        value={newPatientCustomFields[field.field_key] ?? ''}
                        onChange={(e) => setNewPatientCustomFields((p) => ({ ...p, [field.field_key]: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setShowNewPatientModal(false); setNewPatientCustomFields({}); npResetNameFields(); setTimeout(() => patientInputRef.current?.focus(), 50); }}
                  className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
                  disabled={creatingPatient}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    creatingPatient ||
                    !npFirstName.trim() ||
                    (patientFormSettings.age_mode !== 'dob' && !newPatient.age) ||
                    (patientFormSettings.phone_required && !newPatient.phone)
                  }
                  className="px-5 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  {creatingPatient ? 'Saving…' : 'Save Patient'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TRF Review Modal */}
      {showTRFReview && trfExtraction && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                <h3 className="text-lg font-semibold text-gray-900">
                  AI Extracted Data Review & Edit
                </h3>
                <span className="text-xs text-gray-500 bg-blue-50 px-2 py-1 rounded">
                  Click fields to edit
                </span>
              </div>
              <button onClick={handleTRFReviewClose} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Validation Summary */}
              {(() => {
                const validation = validateTRFExtractionData(trfExtraction);
                const hasPatientIssues = !validation.hasMatchedPatient && !validation.patientValid;
                const hasDoctorIssues = !validation.hasMatchedDoctor && trfExtraction.doctorInfo?.name && !trfCreateNewDoctor;

                if (hasPatientIssues || hasDoctorIssues) {
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-4">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="font-medium text-amber-800">Action Required</p>
                          <ul className="text-sm text-amber-700 mt-1 space-y-1">
                            {hasPatientIssues && validation.patientMissingFields.length > 0 && (
                              <li>• Patient: Please fill in {validation.patientMissingFields.join(', ')}</li>
                            )}
                            {hasDoctorIssues && (
                              <li>• Doctor "{trfExtraction.doctorInfo?.name}" not found. Check "Create New Doctor" to add them.</li>
                            )}
                          </ul>
                        </div>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}
              {/* Patient Information - Always show, initialize if needed */}
              {(() => {
                // Ensure patientInfo exists for form fields
                const patientInfo = trfExtraction.patientInfo || { name: '', confidence: 0 };
                const validation = validateTRFExtractionData(trfExtraction);
                const isNewPatient = !trfExtraction.matchedPatient;

                // Helper to check if field is missing/invalid
                const isFieldMissing = (field: string) => {
                  if (trfExtraction.matchedPatient) return false; // Don't show errors for matched patients
                  return validation.patientMissingFields.some(f => f.toLowerCase().includes(field.toLowerCase()));
                };

                return (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium text-gray-900 flex items-center gap-2">
                        <User className="w-4 h-4" />
                        Patient Information
                        {isNewPatient && (
                          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">New Patient</span>
                        )}
                      </h4>
                      {patientInfo.confidence > 0 && (
                        <span className={`text-xs px-2 py-1 rounded-full ${formatConfidence(patientInfo.confidence).bgColor
                          } ${formatConfidence(patientInfo.confidence).color}`}>
                          {formatConfidence(patientInfo.confidence).label}
                        </span>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-lg">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">
                          Name <span className="text-red-500">*</span>
                          {isFieldMissing('name') && <span className="text-red-500 ml-1">(Required)</span>}
                        </label>
                        <input
                          type="text"
                          value={patientInfo.name || ''}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            patientInfo: { ...patientInfo, name: e.target.value, confidence: patientInfo.confidence || 0.5 }
                          })}
                          className={`w-full text-sm font-medium border rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                            isFieldMissing('name') ? 'border-red-300 bg-red-50' : 'border-gray-300'
                          }`}
                          placeholder="Enter patient name"
                        />
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs text-gray-500 block mb-1">
                            Age <span className="text-red-500">*</span>
                            {isFieldMissing('age') && <span className="text-red-500 ml-1">(Required)</span>}
                          </label>
                          <input
                            type="number"
                            value={patientInfo.age || ''}
                            onChange={(e) => setTrfExtraction({
                              ...trfExtraction,
                              patientInfo: { ...patientInfo, age: parseInt(e.target.value) || 0, confidence: patientInfo.confidence || 0.5 }
                            })}
                            className={`w-full text-sm font-medium border rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                              isFieldMissing('age') ? 'border-red-300 bg-red-50' : 'border-gray-300'
                            }`}
                            placeholder="Age"
                            min="0"
                            max="150"
                          />
                        </div>
                        <div className="w-24">
                          <label className="text-xs text-gray-500 block mb-1">Unit</label>
                          <select
                            value={(trfExtraction as any).patientInfo?.ageUnit || 'years'}
                            onChange={(e) => setTrfExtraction({
                              ...trfExtraction,
                              patientInfo: {
                                ...patientInfo,
                                confidence: patientInfo.confidence || 0.5,
                                ageUnit: e.target.value as 'years' | 'months' | 'days'
                              }
                            } as any)}
                            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="years">Years</option>
                            <option value="months">Months</option>
                            <option value="days">Days</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">
                          Gender <span className="text-red-500">*</span>
                        </label>
                        <select
                          value={patientInfo.gender || 'Male'}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            patientInfo: { ...patientInfo, gender: e.target.value as 'Male' | 'Female' | 'Other', confidence: patientInfo.confidence || 0.5 }
                          })}
                          className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">
                          Phone <span className="text-red-500">*</span>
                          {isFieldMissing('phone') && <span className="text-red-500 ml-1">(10 digits required)</span>}
                        </label>
                        <input
                          type="tel"
                          value={patientInfo.phone || ''}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            patientInfo: { ...patientInfo, phone: e.target.value, confidence: patientInfo.confidence || 0.5 }
                          })}
                          className={`w-full text-sm font-medium border rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 ${
                            isFieldMissing('phone') ? 'border-red-300 bg-red-50' : 'border-gray-300'
                          }`}
                          placeholder="10-digit phone number"
                          maxLength={10}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="text-xs text-gray-500 block mb-1">Email (optional)</label>
                        <input
                          type="email"
                          value={patientInfo.email || ''}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            patientInfo: { ...patientInfo, email: e.target.value, confidence: patientInfo.confidence || 0.5 }
                          })}
                          className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          placeholder="Enter email (optional)"
                        />
                      </div>
                    </div>

                    {/* Matched Patient */}
                    {trfExtraction.matchedPatient && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-green-600" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-green-800">
                              Matched Existing Patient
                            </p>
                            <p className="text-xs text-green-700">
                              {trfExtraction.matchedPatient.name} • {trfExtraction.matchedPatient.phone}
                              {' '} • {Math.round(trfExtraction.matchedPatient.matchConfidence * 100)}% match
                            </p>
                            {trfExtraction.matchedPatient.matchReason && (
                              <p className="text-xs text-green-600 mt-1">
                                {trfExtraction.matchedPatient.matchReason === 'phone_and_name' && '✓ Matched by phone and name'}
                                {trfExtraction.matchedPatient.matchReason === 'phone_only' && '⚠ Matched by phone only (no name in TRF)'}
                                {trfExtraction.matchedPatient.matchReason === 'phone_only_name_mismatch' && '⚠ Phone matches but name differs - please verify'}
                                {trfExtraction.matchedPatient.matchReason === 'name_only' && '✓ Matched by name only'}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* New Patient Info */}
                    {isNewPatient && patientInfo.name && validation.patientValid && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <UserPlus className="w-4 h-4 text-blue-600" />
                          <div>
                            <p className="text-sm font-medium text-blue-800">
                              New Patient Will Be Created
                            </p>
                            <p className="text-xs text-blue-700">
                              No existing patient found. A new patient record will be created when you continue.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Missing Fields Warning for New Patient */}
                    {isNewPatient && !validation.patientValid && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-red-600" />
                          <div>
                            <p className="text-sm font-medium text-red-800">
                              Missing Required Information
                            </p>
                            <p className="text-xs text-red-700">
                              Please fill in: {validation.patientMissingFields.join(', ')}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Requested Tests */}
              {trfExtraction.requestedTests && trfExtraction.requestedTests.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-medium text-gray-900 flex items-center gap-2">
                    <TestTube className="w-4 h-4" />
                    Requested Tests ({trfExtraction.requestedTests.filter(t => t.isSelected).length} selected)
                  </h4>

                  <div className="space-y-2">
                    {trfExtraction.requestedTests.map((test, idx) => (
                      <div
                        key={idx}
                        className={`p-3 rounded-lg border ${test.matched
                          ? 'bg-green-50 border-green-200'
                          : 'bg-yellow-50 border-yellow-200'
                          }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3 flex-1">
                            <input
                              type="checkbox"
                              checked={test.isSelected}
                              onChange={(e) => {
                                const updatedTests = [...trfExtraction.requestedTests!];
                                updatedTests[idx] = { ...updatedTests[idx], isSelected: e.target.checked };
                                setTrfExtraction({
                                  ...trfExtraction,
                                  requestedTests: updatedTests
                                });
                              }}
                              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-2 focus:ring-blue-500"
                            />
                            <div className="flex-1">
                              <input
                                type="text"
                                value={test.testName}
                                onChange={(e) => {
                                  const updatedTests = [...trfExtraction.requestedTests!];
                                  updatedTests[idx] = { ...updatedTests[idx], testName: e.target.value };
                                  setTrfExtraction({
                                    ...trfExtraction,
                                    requestedTests: updatedTests
                                  });
                                }}
                                className="text-sm font-medium bg-transparent border-0 border-b border-transparent hover:border-gray-300 focus:border-blue-500 focus:ring-0 w-full"
                              />
                              {test.matched && test.matchedTestName && (
                                <p className="text-xs text-gray-600 mt-1">
                                  Matched to: {test.matchedTestName}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {test.matched ? (
                              <CheckCircle className="w-4 h-4 text-green-600" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-yellow-600" />
                            )}
                            <span className="text-xs text-gray-500">
                              {Math.round((test.matchConfidence || test.confidence) * 100)}%
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Doctor Information */}
              {(trfExtraction.doctorInfo?.name || trfExtraction.matchedDoctor) && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-medium text-gray-900 flex items-center gap-2">
                      <Stethoscope className="w-4 h-4" />
                      Referring Doctor
                    </h4>
                    {trfExtraction.doctorInfo && (
                      <span className={`text-xs px-2 py-1 rounded-full ${formatConfidence(trfExtraction.doctorInfo.confidence || 0.5).bgColor
                        } ${formatConfidence(trfExtraction.doctorInfo.confidence || 0.5).color}`}>
                        {formatConfidence(trfExtraction.doctorInfo.confidence || 0.5).label}
                      </span>
                    )}
                  </div>

                  <div className="bg-gray-50 p-4 rounded-lg space-y-3">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Doctor Name</label>
                        <input
                          type="text"
                          value={trfExtraction.doctorInfo?.name || ''}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            doctorInfo: {
                              ...trfExtraction.doctorInfo!,
                              name: e.target.value,
                              confidence: trfExtraction.doctorInfo?.confidence || 0.5
                            }
                          })}
                          className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          placeholder="Enter doctor name"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 block mb-1">Specialization (optional)</label>
                        <input
                          type="text"
                          value={trfExtraction.doctorInfo?.specialization || ''}
                          onChange={(e) => setTrfExtraction({
                            ...trfExtraction,
                            doctorInfo: {
                              ...trfExtraction.doctorInfo!,
                              specialization: e.target.value,
                              confidence: trfExtraction.doctorInfo?.confidence || 0.5
                            }
                          })}
                          className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                          placeholder="Enter specialization"
                        />
                      </div>
                    </div>

                    {/* Matched Doctor */}
                    {trfExtraction.matchedDoctor && trfExtraction.matchedDoctor.matchConfidence >= 0.7 && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                        <div className="flex items-center gap-2">
                          <CheckCircle className="w-4 h-4 text-green-600" />
                          <div className="flex-1">
                            <p className="text-sm font-medium text-green-800">
                              Matched Existing Doctor
                            </p>
                            <p className="text-xs text-green-700">
                              {trfExtraction.matchedDoctor.name}
                              {trfExtraction.matchedDoctor.specialization && ` • ${trfExtraction.matchedDoctor.specialization}`}
                              {' '} • {Math.round(trfExtraction.matchedDoctor.matchConfidence * 100)}% match
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* New Doctor - option to create */}
                    {!trfExtraction.matchedDoctor && trfExtraction.doctorInfo?.name && trfExtraction.doctorInfo.name.trim().length >= 2 && (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <AlertTriangle className="w-4 h-4 text-amber-600" />
                            <div>
                              <p className="text-sm font-medium text-amber-800">
                                Doctor Not Found
                              </p>
                              <p className="text-xs text-amber-700">
                                No existing doctor matches "{trfExtraction.doctorInfo.name}"
                              </p>
                            </div>
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={trfCreateNewDoctor}
                              onChange={(e) => setTrfCreateNewDoctor(e.target.checked)}
                              className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-2 focus:ring-blue-500"
                            />
                            <span className="text-sm text-amber-800 font-medium">Create New Doctor</span>
                          </label>
                        </div>
                        {trfCreateNewDoctor && (
                          <p className="text-xs text-green-700 mt-2 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" />
                            A new doctor record will be created when you continue
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Clinical Notes */}
              {trfExtraction.clinicalNotes && (
                <div className="space-y-3">
                  <h4 className="font-medium text-gray-900">Clinical Notes</h4>
                  <div className="bg-gray-50 p-4 rounded-lg">
                    <textarea
                      value={trfExtraction.clinicalNotes}
                      onChange={(e) => setTrfExtraction({
                        ...trfExtraction,
                        clinicalNotes: e.target.value
                      })}
                      rows={3}
                      className="w-full text-sm text-gray-700 border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter clinical notes"
                    />
                  </div>
                </div>
              )}

              {/* Additional Info */}
              <div className="grid grid-cols-2 gap-4">
                {trfExtraction.location !== undefined && (
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Location</label>
                    <input
                      type="text"
                      value={trfExtraction.location || ''}
                      onChange={(e) => setTrfExtraction({
                        ...trfExtraction,
                        location: e.target.value
                      })}
                      className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter location"
                    />
                  </div>
                )}
                {trfExtraction.urgency !== undefined && (
                  <div>
                    <label className="text-xs text-gray-500 block mb-1">Urgency</label>
                    <select
                      value={trfExtraction.urgency || 'Normal'}
                      onChange={(e) => setTrfExtraction({
                        ...trfExtraction,
                        urgency: e.target.value as 'Normal' | 'Urgent' | 'STAT'
                      })}
                      className="w-full text-sm font-medium border border-gray-300 rounded px-2 py-1.5 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="Normal">Normal</option>
                      <option value="Urgent">Urgent</option>
                      <option value="STAT">STAT</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-gray-200 p-4 flex items-center justify-between bg-gray-50">
              <div className="text-xs text-gray-600 space-y-1">
                <p className="flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-green-600" />
                  Changes saved automatically
                </p>
                {(() => {
                  const actions: string[] = [];
                  if (!trfExtraction.matchedPatient && trfExtraction.patientInfo?.name) {
                    actions.push('Create new patient');
                  }
                  if (trfCreateNewDoctor && trfExtraction.doctorInfo?.name) {
                    actions.push('Create new doctor');
                  }
                  if (trfExtraction.matchedPatient) {
                    actions.push('Use existing patient');
                  }
                  if (trfExtraction.matchedDoctor) {
                    actions.push('Use existing doctor');
                  }
                  return actions.length > 0 ? (
                    <p className="text-blue-700 font-medium">
                      Will: {actions.join(', ')}
                    </p>
                  ) : null;
                })()}
              </div>
              <button
                onClick={handleTRFReviewClose}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm font-medium"
              >
                Continue with Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Online collection at booking time: the order and invoice already exist,
          the gateway settles the invoice once the patient pays. */}
      {onlineCollection && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Collect Payment Online</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  Order registered for {onlineCollection.patientName}
                  {onlineCollection.invoiceNumber ? ` · Invoice ${onlineCollection.invoiceNumber}` : ''}
                </p>
              </div>
              <button
                onClick={() => {
                  setOnlineCollection(null);
                  finishSuccessfulSubmit('Order and invoice created. Payment pending.');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <OnlinePaymentQR
              labId={onlineCollection.labId}
              invoiceId={onlineCollection.invoiceId}
              invoiceNumber={onlineCollection.invoiceNumber || undefined}
              patientId={onlineCollection.patientId}
              payerName={onlineCollection.patientName}
              payerPhone={onlineCollection.patientPhone}
              amount={onlineCollection.amount}
              onPaid={() => {
                setTimeout(() => {
                  setOnlineCollection(null);
                  finishSuccessfulSubmit('Payment received. Order created successfully!');
                }, 1500);
              }}
              onCancel={() => {
                setOnlineCollection(null);
                finishSuccessfulSubmit('Order and invoice created. Collect payment later.');
              }}
            />
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

export default OrderForm;
