import { auth, firebaseConfig } from '../firebase/config';

export interface OrdersBackendResponse {
  success: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

export class OrdersBackendError extends Error {
  readonly status: number;
  readonly payload: OrdersBackendResponse | null;

  constructor(message: string, status: number, payload: OrdersBackendResponse | null) {
    super(message);
    this.name = 'OrdersBackendError';
    this.status = status;
    this.payload = payload;
  }
}

/**
 * Calls an authenticated HTTP Cloud Function in the orders-backend codebase.
 * The Firebase ID token is always obtained from the current signed-in user.
 */
export async function callOrdersBackend<T extends OrdersBackendResponse = OrdersBackendResponse>(
  functionName: string,
  payload: Record<string, unknown>
): Promise<T> {
  const currentUser = auth?.currentUser;
  if (!currentUser) {
    throw new OrdersBackendError('يجب تسجيل الدخول قبل تنفيذ العملية', 401, null);
  }

  const projectId = String(firebaseConfig.projectId || '').trim();
  const region = String(import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1').trim();

  if (!projectId || !region) {
    throw new OrdersBackendError('إعدادات Firebase Cloud Functions غير مكتملة', 500, null);
  }

  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(functionName)) {
    throw new OrdersBackendError('اسم وظيفة السيرفر غير صالح', 400, null);
  }

  const idToken = await currentUser.getIdToken();
  const url = `https://${region}-${projectId}.cloudfunctions.net/${functionName}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new OrdersBackendError(`تعذر الاتصال بخادم الطلبات: ${message}`, 0, null);
  }

  let result: OrdersBackendResponse | null = null;
  try {
    result = (await response.json()) as OrdersBackendResponse;
  } catch {
    result = null;
  }

  if (!response.ok || result?.success === false) {
    const message =
      (typeof result?.error === 'string' && result.error) ||
      (typeof result?.message === 'string' && result.message) ||
      `فشل تنفيذ العملية على السيرفر (HTTP ${response.status})`;
    throw new OrdersBackendError(message, response.status, result);
  }

  if (!result || typeof result !== 'object') {
    throw new OrdersBackendError('استجابة السيرفر غير صالحة', response.status, null);
  }

  return result as T;
}
