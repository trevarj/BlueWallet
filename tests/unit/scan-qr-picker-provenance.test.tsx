import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import { encodeUR } from '../../blue_modules/ur';
import loc from '../../loc';
import ScanQRCode from '../../screen/send/ScanQRCode';

const mockDispatch = jest.fn();
const mockGoBack = jest.fn();
const mockShowFilePicker = jest.fn();
const mockNavigation = {
  dispatch: mockDispatch,
  goBack: mockGoBack,
  getState: () => ({ routes: [{ name: 'PsbtWithHardwareWallet' }, { name: 'ScanQRCode' }] }),
};
const mockRoute = {
  params: {
    launchedBy: 'PsbtWithHardwareWallet',
    showFileImportButton: true,
  },
};

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => mockNavigation,
    useRoute: () => mockRoute,
    useIsFocused: () => true,
  };
});
jest.mock('../../blue_modules/fs', () => ({
  showFilePickerAndReadFile: (...args: unknown[]) => mockShowFilePicker(...args),
  showImagePickerAndReadImage: jest.fn(async () => undefined),
}));
jest.mock('../../helpers/scan-qr', () => ({ isCameraAuthorizationStatusGranted: jest.fn(async () => false) }));
jest.mock('../../components/themes', () => ({
  useTheme: () => ({ colors: { brandingColor: '#111', foregroundColor: '#222', formBorder: '#333', inputBackgroundColor: '#fff' } }),
}));
jest.mock('../../components/Button', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ onPress, title }: { onPress?: () => void; title: string }) =>
      ReactModule.createElement(Pressable, { onPress, testID: title }, ReactModule.createElement(Text, null, title)),
  };
});
jest.mock('../../components/BlueText', () => 'BlueText');
jest.mock('../../components/CameraScreen', () => 'CameraScreen');
jest.mock('../../components/SafeArea', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  return { __esModule: true, default: ({ children }: { children: React.ReactNode }) => ReactModule.createElement(View, null, children) };
});
jest.mock('../../components/BlueLoading', () => ({ BlueLoading: 'BlueLoading' }));
jest.mock('../../class/camera', () => ({ openPrivacyDesktopSettings: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockShowFilePicker.mockResolvedValue({ data: encodeUR('picked-psbt', 5_000, null, 'BBQR')[0] });
});

test('preserves native picker provenance through a single-part BBQR decode', async () => {
  const view = render(<ScanQRCode />);
  const importButton = await view.findByTestId(loc.wallets.import_file);
  await act(async () => {
    fireEvent.press(importButton);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          name: 'PsbtWithHardwareWallet',
          params: expect.objectContaining({ onBarScanned: 'picked-psbt', onBarScannedFromPicker: true }),
        }),
      }),
    ),
  );
});
