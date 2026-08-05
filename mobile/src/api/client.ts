import axios, { AxiosError } from 'axios';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Which server this build talks to, from `extra.apiBaseUrl` in app.json — a LAN
 * address for on-device testing, a hosted one for a real build. Baked in at
 * build time, so switching backends is a config edit rather than a code change.
 */
const configured = Constants.expoConfig?.extra?.apiBaseUrl as string | undefined;

if (!configured && __DEV__) {
  console.warn('extra.apiBaseUrl is not set in app.json; falling back to localhost.');
}

export const API_BASE_URL = configured ?? 'http://localhost:4000/api';

const TOKEN_KEY = 'pos_token';

/**
 * Token lives in SecureStore (Android Keystore), not AsyncStorage — it is a
 * long-lived credential and the device may be shared between shift staff.
 */
export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(async (config) => {
  const token = await getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Set by the root layout so a 401 can bounce the user to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    if (error.response?.status === 401) {
      await clearToken();
      onUnauthorized?.();
    }
    return Promise.reject(error);
  }
);

/** Turns an axios failure into something worth showing a cashier. */
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { detail?: string; message?: string } | undefined;
    if (data?.detail) return data.detail;
    if (data?.message) return data.message;
    if (error.code === 'ECONNABORTED') return 'The server took too long to respond.';
    if (!error.response) return 'No connection to the server.';
    return `Request failed (${error.response.status}).`;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** True when the failure is a lost/absent network rather than a server refusal. */
export function isNetworkError(error: unknown): boolean {
  return axios.isAxiosError(error) && !error.response;
}
