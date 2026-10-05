import { Platform } from 'react-native';
import NativeSettingsModule from '../codegen/NativeSettingsModule';

// Only available on Android
const SettingsModule = Platform.OS === 'android' ? NativeSettingsModule : null;

export default SettingsModule;
