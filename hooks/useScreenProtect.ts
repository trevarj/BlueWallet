import { useCallback, useRef } from 'react';
import { CaptureProtection } from 'react-native-capture-protection';
import { isDesktop } from '../blue_modules/environment';

export type ScreenProtectLease = {
  release: () => Promise<void>;
};

const activeLeases = new Set<symbol>();
let transition: Promise<void> = Promise.resolve();

const enqueue = <Value>(operation: () => Promise<Value>): Promise<Value> => {
  const result = transition.then(operation, operation);
  transition = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export const acquireScreenProtectLease = async (): Promise<ScreenProtectLease> => {
  if (isDesktop) return { release: () => Promise.resolve() };
  const token = Symbol('screen-protect-owner');
  await enqueue(async () => {
    if (activeLeases.size === 0) await CaptureProtection.prevent();
    activeLeases.add(token);
  });
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await enqueue(async () => {
        if (!activeLeases.delete(token)) return;
        if (activeLeases.size === 0) await CaptureProtection.allow();
      });
    },
  };
};

export const useScreenProtect = () => {
  const leaseRef = useRef<ScreenProtectLease | undefined>(undefined);
  const pendingRef = useRef<Promise<ScreenProtectLease> | undefined>(undefined);
  const generationRef = useRef(0);

  const enableScreenProtect = useCallback(async () => {
    if (leaseRef.current) return;
    const generation = generationRef.current;
    const pending = pendingRef.current ?? acquireScreenProtectLease();
    pendingRef.current = pending;
    let lease: ScreenProtectLease;
    try {
      lease = await pending;
    } catch (error) {
      if (pendingRef.current === pending) pendingRef.current = undefined;
      throw error;
    }
    if (generationRef.current !== generation) {
      await lease.release();
      return;
    }
    leaseRef.current = lease;
    if (pendingRef.current === pending) pendingRef.current = undefined;
  }, []);

  const disableScreenProtect = useCallback(async () => {
    generationRef.current += 1;
    const lease = leaseRef.current;
    const pending = pendingRef.current;
    leaseRef.current = undefined;
    pendingRef.current = undefined;
    if (lease) {
      await lease.release();
    } else if (pending) {
      const acquired = await pending;
      await acquired.release();
    }
  }, []);

  const isScreenBeingRecorded = useCallback(async () => {
    if (isDesktop) return false;
    return await CaptureProtection.isScreenRecording();
  }, []);

  return {
    enableScreenProtect,
    disableScreenProtect,
    isScreenBeingRecorded,
  };
};
