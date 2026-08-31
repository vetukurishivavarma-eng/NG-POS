import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useNavigation } from 'expo-router';

export interface LeaveGuardOptions {
  /**
   * Evaluated at the moment a leave is attempted — return true while there is
   * an entry on screen that would be lost. Read live state here (a store's
   * `getState()`, or the current render's values); it is not memoised.
   */
  hasUnsavedWork: () => boolean;
  title: string;
  message: string;
  /** Label for the "finish it now" action, e.g. "Charge now" / "Post invoice". */
  finishLabel: string;
  /**
   * Complete the sale/invoice. The finish flow is expected to handle its own
   * navigation on success (a receipt prompt, `router.back()`, …), so returning
   * `false` — the normal case — leaves the pending back action alone. Return
   * `true` only if the work is done and this screen should now pop.
   */
  onFinish: () => Promise<boolean>;
  /** Throw the in-progress entry away. The screen then leaves. */
  onDiscard: () => void;
}

/**
 * Asks before leaving a screen that has an unsaved sale or invoice on it —
 * the client's request: "while putting the invoice or sale when we go out our
 * work is not saved. If it can ask to save/post or cancel it can be helpful."
 *
 * Covers the Android back button, the header back arrow and the swipe-back
 * gesture — everything that removes the screen from the stack. It does not
 * fire on a tab switch (the screen is not removed), which is why the cart
 * survives one anyway.
 */
export function useLeaveGuard(options: LeaveGuardOptions) {
  const navigation = useNavigation();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (event) => {
      const opts = optionsRef.current;
      if (!opts.hasUnsavedWork()) return;

      event.preventDefault();
      const leave = () => navigation.dispatch(event.data.action);

      Alert.alert(
        opts.title,
        opts.message,
        [
          { text: 'Keep editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              opts.onDiscard();
              leave();
            },
          },
          {
            text: opts.finishLabel,
            onPress: () => {
              void opts.onFinish().then((done) => {
                if (done) leave();
              });
            },
          },
        ],
        { cancelable: true }
      );
    });

    return unsubscribe;
  }, [navigation]);
}
