import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.grss.floodcrisis',
  appName: 'Flood Crisis Management',
  webDir: 'mobile-shell',
  server: {
    url: 'https://clc-crisis-app-q7vf.vercel.app',
    cleartext: false,
    allowNavigation: ['clc-crisis-app-q7vf.vercel.app'],
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#003ba5',
  },
  ios: {
    backgroundColor: '#003ba5',
    contentInset: 'automatic',
    scrollEnabled: true,
  },
};

export default config;
