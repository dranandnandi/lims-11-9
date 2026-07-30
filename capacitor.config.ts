import type { CapacitorConfig } from '@capacitor/cli';

// APP_TARGET selects which of the three apps is being packaged:
// 'lims' (default) | 'patient' | 'phlebo'. The Android applicationId is
// governed by the matching Gradle product flavor; keep these in sync.
const APP_TARGET = process.env.APP_TARGET || 'lims';

const APP_IDENTITY: Record<string, { appId: string; appName: string; webDir: string }> = {
  lims: { appId: 'com.lims.builder', appName: 'AnPro LIMS', webDir: 'dist' },
  patient: { appId: 'com.anpro.patient', appName: 'AnPro Patient', webDir: 'dist-patient' },
  phlebo: { appId: 'com.anpro.phlebo', appName: 'AnPro Phlebo', webDir: 'dist-phlebo' },
};

const identity = APP_IDENTITY[APP_TARGET] || APP_IDENTITY.lims;

const config: CapacitorConfig = {
  appId: identity.appId,
  appName: identity.appName,
  webDir: identity.webDir,
  server: {
    androidScheme: 'https',
    cleartext: true, // Allow HTTP for development
    hostname: 'localhost',
  },
  plugins: {
    Camera: {
      saveToGallery: true,
      correctOrientation: true,
      quality: 90,
    },
    Filesystem: {
      androidScheme: 'https',
    },
    StatusBar: {
      backgroundColor: '#1a56db',
      style: 'dark',
      overlaysWebView: false, // Don't overlay web content
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    FirebaseMessaging: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
  android: {
    allowMixedContent: true,
    captureInput: true,
    webContentsDebuggingEnabled: true,
    backgroundColor: '#ffffff',
    // Enable safe area insets
    overrideUserAgent: undefined,
    appendUserAgent: 'AnPro-LIMS-Android',
  },
};

export default config;
