import {getFunctions, httpsCallable} from 'firebase/functions';
import {app, auth} from '../firebase/config';

const functions = getFunctions(app, 'us-central1');

/**
 * Typed callable wrapper for server-authoritative admin and merchant operations.
 * Firebase SDK attaches and refreshes the signed-in user's ID token automatically.
 */
export async function callCloudFunction<TRequest extends Record<string, unknown>, TResponse>(
  functionName: string,
  payload: TRequest
): Promise<TResponse> {
  const user = auth?.currentUser;
  if (!user) {
    throw new Error('انتهت جلسة الدخول. سجّل الدخول مرة أخرى ثم أعد المحاولة.');
  }

  await user.getIdToken();
  const callable = httpsCallable<TRequest, TResponse>(functions, functionName, {
    timeout: 60_000,
  });
  const result = await callable(payload);
  return result.data;
}
