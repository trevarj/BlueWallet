import { acquireScreenProtectLease } from '../../hooks/useScreenProtect';

const mockPrevent = jest.fn(async () => undefined);
const mockAllow = jest.fn(async () => undefined);

jest.mock('react-native-capture-protection', () => ({
  CaptureProtection: {
    prevent: () => mockPrevent(),
    allow: () => mockAllow(),
    isScreenRecording: jest.fn(async () => false),
  },
}));

jest.mock('../../blue_modules/environment', () => ({ isDesktop: false }));

beforeEach(() => jest.clearAllMocks());

test('overlapping screen-protection owners release only their own lease', async () => {
  const first = await acquireScreenProtectLease();
  const second = await acquireScreenProtectLease();
  expect(mockPrevent).toHaveBeenCalledTimes(1);

  await first.release();
  expect(mockAllow).not.toHaveBeenCalled();

  await second.release();
  expect(mockAllow).toHaveBeenCalledTimes(1);
});
